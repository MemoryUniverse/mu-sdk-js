"""Standalone launcher for a REAL `mu-engine-server` instance, used ONLY by this JS repo's
integration suite (`engineServer.ts` spawns this as a subprocess exactly the way
`conformanceServer.ts` spawns the Python conformance server).

Not part of the `mu-engine-server` PACKAGE (never imported by it, never shipped in its wheel) —
this file lives here, in `mu-sdk-js`, because D2's OWNERSHIP is `mu-sdk-js` only and
`mu-engine-server` has no module-level `app` singleton yet (`mu_engine_server/app.py`'s own
docstring: "Handoff note for C4 ... not resolved here"). Building one is this script's entire job:
mint a per-process bearer token at the given path (mirroring what `make up` will do in Stage E,
`mu_engine_server/auth.py`'s own documented contract — write, mode 0600), point
`EngineServerSettings.token_path` at it, construct a REAL `EngineServerApp` (real Valkey/Qdrant/
FalkorDB clients per `composition.py`, dev stack already up per this task's CONTEXT PACK), and run
it under a real uvicorn on a free loopback port.

Usage: `uv run python engine_server_launcher.py --token-path <path> [--port <port>]`
(run from `mu-core/`, or with `--project mu-core` — uv resolves the workspace either way, same
invocation shape `conformanceServer.ts` uses for the Python SDK's `uv run uvicorn ...`).
"""

from __future__ import annotations

import argparse
import secrets
import socket
import sys
from pathlib import Path

import uvicorn

from mu_engine_server.composition import EngineServerApp
from mu_engine_server.settings import EngineServerSettings


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _mint_token(token_path: Path) -> str:
    token = secrets.token_urlsafe(32)
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(token, encoding="utf-8")
    token_path.chmod(0o600)
    return token


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--token-path", required=True)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--workspace", default="local")
    parser.add_argument("--namespace", default="default")
    args = parser.parse_args()

    token_path = Path(args.token_path)
    token = _mint_token(token_path)
    port = args.port or _free_port()

    settings = EngineServerSettings(
        token_path=token_path,
        workspace=args.workspace,
        namespace=args.namespace,
    )
    server_app = EngineServerApp(settings)

    # The port is chosen by THIS process (not left to uvicorn's own `--port 0` OS-assignment,
    # unlike `conformanceServer.ts`'s Python counterpart) so it is known up front, before uvicorn
    # has bound anything. Printed so a human/log reader can see it; the JS launcher (`engineServer.ts`)
    # does NOT parse this line for readiness — it already knows the port (it told this process which
    # one to use, or reserved this same free port itself) and instead polls the socket directly,
    # which is the actually-reliable readiness signal (this line can print before uvicorn's listener
    # is bound; a parsed banner would have the same race `conformanceServer.ts` avoids only because
    # uvicorn itself emits that banner AFTER binding).
    print(f"ENGINE_SERVER_STARTING http://127.0.0.1:{port} token={token}", flush=True)
    sys.stdout.flush()

    uvicorn.run(server_app.app, host="127.0.0.1", port=port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
