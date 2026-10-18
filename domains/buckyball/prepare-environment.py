#!/usr/bin/env python3
"""Export committed C/ISA pilot inputs without touching the author's checkout."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

GENERATED = ["examples/chips/toy/configs/generated/" + name for name in [
    "bemu/Cargo.toml", "bemu/Cargo.lock", "bemu/build.rs", "bemu/dispatch.rs", "chip.pb",
    "config/config.json", "config/derived.json", "config/chip.pb", "workload/cmake.defs",
]] + ["bbdev/api/steps/config/scripts/chip_pb2.py"]


def git(repo, *args):
    return subprocess.check_output(["git", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-C", str(repo), *args])


def export(repo, commit, destination, paths=()):
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(git(repo, "archive", commit, *paths))) as archive:
        archive.extractall(destination, filter="data")


def commit(repo, message):
    subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-C", str(repo), "-c", "user.name=Singularity Pilot", "-c", "user.email=pilot@localhost", "commit", "--quiet", "-m", message], check=True,
                   env={**os.environ, "GIT_AUTHOR_DATE": "2026-10-18T00:00:00Z", "GIT_COMMITTER_DATE": "2026-10-18T00:00:00Z"})


def finalize(source):
    """Freeze only generated inputs after real MCP operations; never freeze caches."""
    environment = source.parent
    def evidence(name):
        value = json.loads((environment / name).read_text())
        if value["events"][-1].get("processing") is not False:
            raise ValueError(f"MCP task has no terminal evidence: {name}")
        return value
    configured = evidence("config-mcp.json")
    smoke = evidence("bemu-mcp.json")
    if not configured["events"][-1].get("success") or not smoke["events"][-1].get("success"):
        raise ValueError("Configuration and known-workload BEMU smoke must succeed before finalization")
    isa = source / "bb-tests/workloads/build/toy/generated/isa/toy"
    output = environment / "generated/isa/toy"
    shutil.copytree(isa, output, dirs_exist_ok=True)
    git(source, "add", "--force", "--", *GENERATED)
    if subprocess.run(["git", "-C", str(source), "diff", "--cached", "--quiet"]).returncode:
        commit(source, "Freeze toy config, generated dispatch and resolved BEMU dependency lock")
    paths = {"riscvGcc": (source / "result/bin/riscv64-unknown-linux-gnu-gcc").resolve(),
             "riscvObjdump": (source / "result/bin/riscv64-unknown-linux-gnu-objdump").resolve(),
             "bemu": source / "bebop/target/toy/release/bebop-bemu", "python": (source / "result/bin/python3").resolve(),
             "hostCompiler": Path("/usr/bin/cc").resolve(), "cargo": (source / "result/bin/cargo").resolve()}
    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    known = Path(smoke["events"][-1]["binary"])
    manifest = {"version": 1, "repository": str(source), "sourceCommit": git(source, "rev-parse", "HEAD").decode().strip(),
                "projection": json.loads((source / "PILOT-PROVENANCE.json").read_text()),
                "tools": {name: str(path) for name, path in paths.items()},
                "toolIdentities": {name: {"path": str(path), "sha256": digest(path)} for name, path in paths.items()},
                "generatedIsa": str(output), "generatedIdentities": [{"path": str(path), "sha256": digest(path)} for path in sorted(output.rglob("*")) if path.is_file()],
                "bemuArgv": [str(paths["bemu"]), "--core-index", "0", "--itrace", "--elf", "{elf}", "--log-dir", "{log}"],
                "references": [str(source), str(output)],
                "smoke": {"status": "pass", "scope": "BEMU functional C/ISA only", "traceId": smoke["events"][-1]["trace_id"],
                          "evidence": str(environment / "bemu-mcp.json"), "binary": str(known), "binarySha256": digest(known),
                          "binaryOrigin": "Copied existing upstream build output; not rebuilt from source in this smoke"},
                "limitations": ["Scoped projection, not full recursive upstream reproduction.",
                                 "Broad toy CTest build fails on absent generated AlexNet conv.c; configure generated ISA successfully.",
                                 "No MLIR/RTL/PPA or transfer benefit claim."],
                "evidence": {"config": str(environment / "config-mcp.json"), "bemuOfflineAttempt": str(environment / "bemu-offline-mcp.json"),
                             "workloadConfigure": str(environment / "workload-mcp.json")}}
    (environment / "tools.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"manifest": str(environment / "tools.json"), "sourceCommit": manifest["sourceCommit"]}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("author", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--finalize", action="store_true", help="freeze generated inputs and write tools.json after MCP config/BEMU/workload operations")
    args = parser.parse_args()
    author, destination = args.author.resolve(), args.destination.resolve()
    if args.finalize:
        finalize(destination)
        return
    if destination.exists():
        parser.error("destination must not exist; existing environments are never overwritten")
    upstream = "c3317d2f0739f829c93a86bee145acc191898e81"
    modules = [".agents/mcps", ".agents/skills", "bbdev", "bebop", "bb-tests/workloads/lib/kernel", "thirdparty/soc-framework", "stack"]
    links = {}
    for record in git(author, "ls-tree", "-rz", upstream).decode().split("\0"):
        if record.startswith("160000 "):
            metadata, name = record.split("\t", 1)
            links[name] = metadata.split()[2]
    export(author, upstream, destination)
    retained = []
    for name in modules:
        paths = ("runtime", "compiler/scripts", "LICENSE") if name == "stack" else ()
        export(author / name, links[name], destination / name, paths)
        retained.append({"path": name, "commit": links[name], "projection": list(paths) or ["."]})
    for path in destination.rglob(".gitmodules"):
        path.unlink()
    provenance = {"version": 1, "kind": "C/ISA pilot projection; not a full recursive upstream reproduction",
                  "upstreamCommit": upstream, "includedModules": retained,
                  "omittedGitlinks": [{"path": name, "commit": commit} for name, commit in links.items() if name not in modules],
                  "adaptations": ["flatten retained module objects", "remove .gitmodules", "expose existing config/install API as bbdev_config_install MCP tool", "disable development hot reload so generated chip_pb2.py cannot interrupt configuration", "carry cancellation trace_id in request body to support current Motia route parameters"]}
    (destination / "PILOT-PROVENANCE.json").write_text(json.dumps(provenance, indent=2) + "\n")
    server = destination / "bbdev/mcp/server.py"
    text = server.read_text()
    text = text.replace("register_all(mcp)", 'register_all(mcp)\n\n@mcp.tool()\ndef bbdev_config_install() -> str:\n    """Regenerate chip configuration through the existing asynchronous API."""\n    from common import fmt, submit\n    return fmt(submit("/config/install", {}))')
    server.write_text(text)
    config = destination / "bbdev/api/config.yaml"
    config.write_text(config.read_text().replace("      watch:\n        - steps/**/*.py\n", ""))
    cancel = destination / "bbdev/mcp/tools/task_cancel.py"
    cancel.write_text(cancel.read_text().replace('submit(f"/task/{trace_id}/cancel", {})', 'submit(f"/task/{trace_id}/cancel", {"trace_id": trace_id})'))
    cancel = destination / "bbdev/api/steps/common/02_cancel_api.step.py"
    cancel.write_text(cancel.read_text().replace('request.path_params.get("trace_id", "")', 'request.path_params.get("trace_id", "") or request.body.get("trace_id", "")'))
    git(destination, "init", "--quiet")
    git(destination, "add", "--force", ".")
    commit(destination, "Freeze minimal Buckyball C/ISA pilot source projection")
    environment = Path("/nix/store/rnlmldvh1w5hlq7giv5rnjqmv456fnj6-buckyball-environment")
    (destination / "result").symlink_to(environment)
    shutil.copytree(author / "bbdev/api/.venv", destination / "bbdev/api/.venv", symlinks=True)
    python = destination / "bbdev/api/.venv/bin/python"
    python.unlink()
    python.symlink_to((environment / "bin/python3").resolve())
    for script in (destination / "bbdev/api/.venv/bin").iterdir():
        if script.is_symlink() or not script.is_file():
            continue
        data = script.read_bytes()
        original = str(author / "bbdev/api/.venv").encode()
        if data.startswith(b"#!") and original in data.split(b"\n", 1)[0]:
            script.write_bytes(data.replace(original, str(destination / "bbdev/api/.venv").encode(), 1))
    print(json.dumps({"repository": str(destination), "sourceCommit": git(destination, "rev-parse", "HEAD").decode().strip(), "provenance": provenance}, indent=2))


if __name__ == "__main__":
    main()
