#!/usr/bin/env python3
"""Drop-in deploy entrypoint for the Decillion CI.

`decillionai-server/scripts/ci-deploy.sh` deploys the platform's agent backbone by
running `$DAVINCI_DIR/scripts/deploy_davinci_agent.py` with a fixed environment
contract (`DAVINCI_REUSE_PROGRAM_ID`, `DAVINCI_ENTITY_ID`,
`DAVINCI_STOP_PROGRAM_ID`, `CASPAR_NODE_HOST/PORT`, `CASPAR_CA_BUNDLE`) and greps
`DAVINCI_PROGRAM_ID` / `DAVINCI_ENTITY_ID` / `DAVINCI_VM_ID` out of the output.

Pointing `DAVINCI_DIR` (and `DAVINCI_REPO`) at *this* repository therefore swaps
the platform's agent backbone from the davinci agent to Claude Code with no change
to Decillion and no change to Caspar: this file is that entrypoint, and it simply
runs `deploy_claude_creature.py`, which honours the same environment contract and
prints the same markers.

Run `scripts/deploy_claude_creature.py` directly for a manual deploy — it is the
canonical name and documents every knob.
"""

import runpy
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

if __name__ == "__main__":
    sys.argv[0] = str(HERE / "deploy_claude_creature.py")
    runpy.run_path(str(HERE / "deploy_claude_creature.py"), run_name="__main__")
