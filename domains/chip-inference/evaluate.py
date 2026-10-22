#!/usr/bin/env python3
"""Independent RTL functional checks and frozen Yosys/OpenSTA measurements.

This is a module-level, pre-layout operator harness. It is not a model flow,
a routed-silicon flow or a full-chip Verilator run.
"""
import argparse, hashlib, json, math, os, re, signal, subprocess, tempfile, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS = None
DEADLINE = None

class EvidenceUnavailable(Exception): pass
class DesignFailure(Exception): pass

def run(argv, cwd, seconds=45):
    p=None
    try:
        if DEADLINE is not None:
            seconds=min(seconds,DEADLINE-time.monotonic())
            if seconds<=0:raise DesignFailure('design exceeds the frozen 50-second evaluation bound')
        p = subprocess.Popen(argv, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                             start_new_session=True,
                             env={**os.environ, 'OMP_NUM_THREADS':'1', 'OPENBLAS_NUM_THREADS':'1', 'CXX':TOOLS['cxx']})
        stdout,stderr=p.communicate(timeout=seconds)
    except FileNotFoundError as e:
        raise EvidenceUnavailable(str(e)) from e
    except BaseException as e:
        if p is not None and p.poll() is None:
            os.killpg(p.pid,signal.SIGKILL);p.communicate()
        if isinstance(e,subprocess.TimeoutExpired):raise DesignFailure('design exceeds frozen execution timeout') from e
        raise
    if p.returncode:
        raise DesignFailure('command failed: '+argv[0]+'\n'+(stdout+stderr)[-6000:])
    return stdout+stderr

def pins():
    m=json.loads((ROOT/'external-tools.json').read_text())
    for tool in m['files']:
        p=Path(tool['path'])
        if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=tool['sha256']:
            raise EvidenceUnavailable('frozen external tool/library drift: '+str(p))
    return m

def read_workload(path_or_object):
    if isinstance(path_or_object,(str,os.PathLike)):
        workload=json.loads(Path(path_or_object).read_text())
    else:
        workload=path_or_object
    if not isinstance(workload,dict):raise DesignFailure('workload must be a JSON object')
    case_id=workload.get('caseId')
    k=workload.get('k')
    seed=workload.get('seed')
    if not isinstance(case_id,str) or not case_id:raise DesignFailure('workload caseId must be a nonempty string')
    if type(k) is not int or not 8<=k<=65536 or k%8:
        raise DesignFailure('workload reduction K must be a multiple of eight between 8 and 65536')
    if type(seed) is not int or not 0<=seed<=0xffffffff:
        raise DesignFailure('workload seed must be an unsigned 32-bit integer')
    if workload.get('dots')!=4:raise DesignFailure('frozen oracle requires exactly four dots per workload')
    if workload.get('pairsPerBeat') not in (None,8):raise DesignFailure('frozen oracle requires eight pairs per beat')
    if workload.get('inputDtype') not in (None,'signed-int8'):raise DesignFailure('frozen oracle requires signed INT8 input')
    if workload.get('accumulator') not in (None,'signed-int32-wraparound'):
        raise DesignFailure('frozen oracle requires signed INT32 wraparound accumulation')
    return workload

def validate_source(source):
    if len(source.encode())>131072: raise DesignFailure('source exceeds 128KiB')
    text=re.sub(r'/\*.*?\*/|//[^\n]*','',source,flags=re.S)
    if re.search(r'`|\b(initial|final|force|release|specify|bind|interface|program|primitive|tran|supply0|supply1|always_latch)\b',text):
        raise DesignFailure('use synthesizable plain RTL: no simulation directives, initial blocks or external references')
    if '$' in re.sub(r'\$(?:signed|unsigned|clog2)\b','',text):
        raise DesignFailure('only $signed, $unsigned and $clog2 system functions are permitted; no system tasks')
    if re.findall(r'\bmodule\s+(\w+)',text)!=['accelerator']:
        raise DesignFailure('exactly one module named accelerator is required')
    if re.search(r'\b(real|realtime|shortreal)\b|#\s*\d',text):
        raise DesignFailure('no simulation delays or real-number RTL')
    for event in re.findall(r'@\s*\(([^)]*)\)',text):
        if re.search(r'\b(posedge|negedge)\b',event) and not re.fullmatch(r'\s*posedge\s+clk\s*',event):
            raise DesignFailure('all state must use the single rising-edge clk with synchronous rst_n')
    if re.search(r'\b(negedge)\b|\bposedge\s+(?!clk\b)',text):
        raise DesignFailure('generated, gated and alternate clocks are outside the frozen timing contract')

def simulate(source, case, work, tools):
    validate_source(source)
    k=case['k']
    (work/'accelerator.sv').write_text(source)
    import shutil
    shutil.copyfile(ROOT/'public/oracle.cpp',work/'oracle.cpp')
    log=run([tools['verilator'],'--cc','--exe','--build','-j','1','-Wno-fatal',
             '--top-module','accelerator','--Mdir','obj','accelerator.sv','oracle.cpp',
             '-CFLAGS','-O1 -std=c++17','-MAKEFLAGS','CXX='+tools['cxx']+' LINK='+tools['cxx']],work,90)
    (work/'verilator.log').write_text(log)
    result=run([str(work/'obj/Vaccelerator'),str(k//8),str(case['seed'])],work,20)
    try:checked=json.loads(result)
    except ValueError as e:raise DesignFailure('simulator did not produce independent terminal evidence') from e
    return checked['cycles'],checked['functional_checks']

def synthesize(work,tools):
    lib=tools['liberty']
    (work/'synth.ys').write_text(f'''read_verilog -sv accelerator.sv
synth -top accelerator -noabc
check -assert
select -assert-none t:$_DLATCH_* t:$dlatch t:$adlatch
read_liberty -lib {lib}
dfflibmap -liberty {lib}
abc -liberty {lib}
clean
check -assert
stat -liberty {lib}
write_json mapped.json
write_verilog -noattr -noexpr mapped.v
''')
    log=run([tools['yosys'],'-Q','-T','-s','synth.ys'],work,90)
    (work/'yosys.log').write_text(log)
    mapped=json.loads((work/'mapped.json').read_text())['modules']['accelerator']
    expected={'clk':('input',1),'rst_n':('input',1),'in_valid':('input',1),'in_ready':('output',1),'in_a':('input',64),'in_b':('input',64),'in_last':('input',1),'out_valid':('output',1),'out_ready':('input',1),'out_data':('output',32)}
    actual={k:(v['direction'],len(v['bits'])) for k,v in mapped['ports'].items()}
    if actual!=expected:raise DesignFailure('fixed top-level port contract mismatch')
    if any(c['type'].startswith('$') or 'LATCH' in c['type'].upper() for c in mapped['cells'].values()):
        raise DesignFailure('unmapped cell or latch in synthesized result')
    match=re.search(r"Chip area for module '\\accelerator':\s*([0-9.Ee+-]+)",log)
    if not match:raise EvidenceUnavailable('Yosys area report absent')
    area=float(match[1])
    # OpenSTA's Verilog reader rejects signed declarations. Signedness has no
    # effect after gate mapping; only remove the declaration annotation.
    (work/'mapped.v').write_text((work/'mapped.v').read_text().replace('signed ',''))
    (work/'sta.tcl').write_text(f'''read_liberty {lib}
read_verilog mapped.v
link_design accelerator
create_clock -name clk -period 20 [get_ports clk]
set_input_delay 1 -clock clk [get_ports {{rst_n in_valid in_a* in_b* in_last out_ready}}]
set_output_delay 1 -clock clk [all_outputs]
set_load 0.01 [all_outputs]
puts "SETUP_COVERAGE_RESULT=[check_setup -verbose]"
report_checks -path_delay max -format full_clock_expanded -group_path_count 1 -digits 6
report_worst_slack -max -digits 6
report_power -digits 9
exit
''')
    sta=run([tools['sta'],'-exit','sta.tcl'],work,30)
    (work/'sta.log').write_text(sta)
    if 'Error:' in sta:raise EvidenceUnavailable(sta[-4000:])
    if 'SETUP_COVERAGE_RESULT=1' not in sta or re.search(r'Warning:.*(unclocked|unconstrained|missing set_(input|output)_delay|combinational loop)',sta):
        raise DesignFailure('STA does not cover all clocked state and I/O timing endpoints')
    match=re.search(r'worst slack max\s+([-+0-9.eE]+)',sta)
    if not match:raise EvidenceUnavailable('OpenSTA max timing evidence absent')
    # No clipping: a path that cannot meet the 20ns constraint yields a period
    # above 20ns; a missing or nonpositive estimate is unknown, not rounded.
    period=20-float(match[1])
    power=re.search(r'^Total\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)',sta,re.M)
    result={'area_um2':area,'critical_period_ns':period}
    if power:
        watts=float(power[4])
        if not math.isfinite(watts) or watts<0:raise EvidenceUnavailable('invalid OpenSTA default-activity power')
        result['default_activity_power_w']=watts
    if not all(math.isfinite(result[key]) and result[key]>0 for key in ('area_um2','critical_period_ns')):
        raise EvidenceUnavailable('nonpositive or missing physical estimate')
    return result

def evaluate(source,case_id,synthesis=True,evidence=None,workload=None):
    global TOOLS,DEADLINE
    if workload is None:raise DesignFailure('a frozen workload JSON is required; pass --workload')
    workload=read_workload(workload)
    if case_id is None:case_id=workload['caseId']
    if not isinstance(case_id,str) or case_id!=workload['caseId']:
        raise DesignFailure('case id differs from the frozen workload caseId')
    manifest=pins();TOOLS=manifest['tools'];DEADLINE=time.monotonic()+50
    with tempfile.TemporaryDirectory(prefix='singularity-accelerator-') as temp:
        work=Path(temp);cycles,checks=simulate(source,workload,work,manifest['tools'])
        result={'cycles':cycles,'functional_checks':checks,'caseId':case_id,'sourceSha256':hashlib.sha256(source.encode()).hexdigest()}
        if synthesis:result.update(synthesize(work,manifest['tools']))
        if evidence:
            import shutil
            evidence.mkdir(parents=True,exist_ok=True)
            for name in ['verilator.log','yosys.log','sta.log','synth.ys','sta.tcl']:
                if (work/name).exists():shutil.copyfile(work/name,evidence/name)
            (evidence/'result.json').write_text(json.dumps(result,indent=2)+'\n')
        return result

if __name__=='__main__':
    def cancelled(signum,frame):raise KeyboardInterrupt('measurement cancelled')
    signal.signal(signal.SIGTERM,cancelled)
    p=argparse.ArgumentParser()
    p.add_argument('artifact',type=Path)
    p.add_argument('case',nargs='?',default=None)
    p.add_argument('--workload',type=Path,required=True)
    p.add_argument('--functional-only',action='store_true')
    p.add_argument('--evidence',type=Path)
    a=p.parse_args()
    try:
        workload=read_workload(a.workload)
        print(json.dumps(evaluate(a.artifact.read_text(),a.case or workload['caseId'],not a.functional_only,a.evidence,workload)))
    except EvidenceUnavailable as e:print(json.dumps({'status':'unknown','detail':str(e)}));raise SystemExit(4)
    except (DesignFailure,ValueError,OSError) as e:print(json.dumps({'status':'fail','detail':str(e)}));raise SystemExit(1)
