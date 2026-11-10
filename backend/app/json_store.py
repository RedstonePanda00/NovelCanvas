from __future__ import annotations

import json
import os
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def atomic_write_json(path: Path, data: Any, *, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        delete=False,
        prefix=f".{path.name}.",
        suffix=".tmp",
    ) as handle:
        if compact:
            handle.write(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
        else:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temp_name = handle.name

    os.replace(temp_name, path)
