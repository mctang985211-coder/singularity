#!/usr/bin/env python3
"""Evaluate a standalone kernel_3mm C source. Requires Linux, GCC and OpenMP; no Python packages.

Run: /usr/bin/python3 inputs/benchmark.py kernel.c
Both sources use gcc -O3 -march=native -std=c11 -fopenmp -shared -fPIC -lm.
The baseline is reference.c beside this script. At most four allowed CPUs and
OpenMP threads are used. POLYBENCH_LOCK can name the shared deployment reference
file to serialize measurements across isolated Task workspaces.
Only the C function is timed. All G elements must satisfy atol=1e-9, rtol=1e-9;
A/B/C/D must be unchanged. E/F are scratch. Exit 0 means numerical checks passed;
the JSON reports speedup and whether the 1.20x performance target was reached.
"""
import argparse
import array
import ctypes
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import random
import resource
import statistics
import subprocess
import sys
import tempfile
import time

REFERENCE = Path(__file__).resolve().with_name('reference.c')
SIZES = [(16, 18, 20, 22, 24), (40, 50, 60, 70, 80),
         (17, 23, 31, 19, 29), (180, 190, 200, 210, 220)]


def load(path):
    library = ctypes.CDLL(str(path))
    function = library.kernel_3mm
    function.argtypes = [ctypes.c_int] * 5 + [ctypes.POINTER(ctypes.c_double)] * 7
    function.restype = None
    return function


def data(shape, rng):
    ni, nj, nk, nl, nm = shape
    counts = [ni * nj, ni * nk, nk * nj, nj * nl, nj * nm, nm * nl, ni * nl]
    return [array.array('d', (rng.uniform(-1, 1) for _ in range(n)))
            if index in (1, 2, 4, 5) else array.array('d', [float('nan')]) * n
            for index, n in enumerate(counts)]


def call(function, shape, arrays):
    pointers = [(ctypes.c_double * len(values)).from_buffer(values) for values in arrays]
    start_cpu, start = time.process_time(), time.perf_counter()
    function(*shape, *pointers)
    return time.perf_counter() - start, time.process_time() - start_cpu


def check(reference, candidate, shape, rng):
    arrays = data(shape, rng)
    expected = [array.array('d', values) for values in arrays]
    call(reference, shape, expected)
    for _ in range(2):
        # The same candidate must handle fresh values and overwrite old G contents.
        call(candidate, shape, arrays)
        for index in (1, 2, 4, 5):
            if arrays[index].tobytes() != expected[index].tobytes():
                raise ValueError('candidate modified an input at shape {}'.format(shape))
        for index, (actual, wanted) in enumerate(zip(arrays[6], expected[6])):
            if not math.isfinite(actual) or not math.isclose(actual, wanted, rel_tol=1e-9, abs_tol=1e-9):
                raise ValueError('incorrect G[{}] at shape {}: {} != {}'.format(index, shape, actual, wanted))
        # Change input values without changing their addresses, catching address-based caches.
        for index in (1, 2, 4, 5):
            for position in range(len(arrays[index])):
                arrays[index][position] = rng.uniform(-1, 1)
            expected[index][:] = arrays[index]
        call(reference, shape, expected)


def worker(baseline, candidate):
    cpus = sorted(os.sched_getaffinity(0))
    seed = int.from_bytes(os.urandom(8), 'little')
    rng = random.Random(seed)
    reference, function = load(baseline), load(candidate)
    for shape in SIZES:
        check(reference, function, shape, rng)
    shape = SIZES[-1]
    baseline_data = data(shape, rng)
    candidate_data = [array.array('d', values) for values in baseline_data]
    call(reference, shape, baseline_data)
    call(function, shape, candidate_data)
    baseline_times, candidate_times, cpu_times = [], [], []
    for trial in range(7):
        order = ['baseline', 'candidate'] if trial % 2 == 0 else ['candidate', 'baseline']
        for name in order:
            elapsed, cpu = call(reference if name == 'baseline' else function, shape,
                                baseline_data if name == 'baseline' else candidate_data)
            (baseline_times if name == 'baseline' else candidate_times).append(elapsed)
            if name == 'candidate':
                cpu_times.append(cpu)
        for actual, wanted in zip(candidate_data[6], baseline_data[6]):
            if not math.isfinite(actual) or not math.isclose(actual, wanted, rel_tol=1e-9, abs_tol=1e-9):
                raise ValueError('candidate failed the timed workload')
    baseline_seconds, candidate_seconds = statistics.median(baseline_times), statistics.median(candidate_times)
    speedup = baseline_seconds / candidate_seconds
    return dict(correct=True, seed=seed, checked_shapes=SIZES, timed_shape=shape,
                baseline_seconds=baseline_seconds, candidate_seconds=candidate_seconds,
                baseline_samples=baseline_times, candidate_samples=candidate_times,
                candidate_cpu_wall_ratio=sum(cpu_times) / sum(candidate_times),
                speedup=speedup, meets_target=speedup >= 1.20,
                cpus=cpus, threads=int(os.environ['OMP_NUM_THREADS']),
                worker_cpu_affinities=[sorted(os.sched_getaffinity(int(task.name)))
                                      for task in Path('/proc/self/task').iterdir()])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('candidate', type=Path)
    parser.add_argument('--threads', type=int, choices=range(1, 5), default=4)
    parser.add_argument('--worker', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker is not None:
        # All descendant threads/processes share this affinity and the OpenMP thread ceiling.
        resource.setrlimit(resource.RLIMIT_CPU, (25, 25))
        print(json.dumps(worker(args.worker, args.candidate), allow_nan=False))
        return
    allowed = sorted(os.sched_getaffinity(0))
    if len(allowed) < args.threads:
        raise ValueError('fewer allowed CPUs than the requested thread count')
    os.sched_setaffinity(0, allowed[:args.threads])
    environment = dict(os.environ, OMP_NUM_THREADS=str(args.threads), OMP_THREAD_LIMIT=str(args.threads),
                       OMP_DYNAMIC='FALSE', OMP_PROC_BIND='TRUE', OMP_PLACES='cores',
                       OMP_WAIT_POLICY='PASSIVE', OPENBLAS_NUM_THREADS=str(args.threads),
                       MKL_NUM_THREADS=str(args.threads))
    candidate = args.candidate.resolve(strict=True)
    with Path(os.environ.get('POLYBENCH_LOCK', str(REFERENCE))).open('rb') as lock, \
            tempfile.TemporaryDirectory(prefix='polybench-') as work:
        # flock works on a read-only descriptor and the same protected inode across Bubbles.
        deadline = time.monotonic() + 60
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError('another timing evaluation held the shared lock for 60 seconds')
                time.sleep(0.05)
        started = time.monotonic()
        paths = []
        for name, source in [('baseline', REFERENCE), ('candidate', candidate)]:
            target = Path(work) / (name + '.so')
            compiled = subprocess.run(['/usr/bin/gcc', '-O3', '-march=native', '-std=c11', '-fopenmp',
                                       '-shared', '-fPIC', str(source), '-o', str(target), '-lm'],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      universal_newlines=True, timeout=20)
            if compiled.returncode != 0:
                raise RuntimeError('{} compilation failed: {}'.format(name, compiled.stderr))
            paths.append(target)
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), str(paths[1]),
                                 '--worker', str(paths[0])], env=environment,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                universal_newlines=True, timeout=30)
        if result.returncode != 0:
            raise RuntimeError('evaluation worker exited {}: {}'.format(result.returncode, result.stderr))
        report = json.loads(result.stdout)
        report.update(candidate_sha256=hashlib.sha256(candidate.read_bytes()).hexdigest(),
                      reference_sha256=hashlib.sha256(REFERENCE.read_bytes()).hexdigest(),
                      evaluation_seconds=time.monotonic() - started)
        print(json.dumps(report, allow_nan=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps(dict(correct=False, error=str(error))), file=sys.stderr)
        sys.exit(1)
