from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

from backend.app.main import app  # noqa: E402


OUTPUT = PROJECT_ROOT / "frontend" / "src" / "generated" / "api-types.ts"


def reference_name(reference: str) -> str:
    return reference.rsplit("/", 1)[-1]


def literal(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    return json.dumps(value, ensure_ascii=False)


def ts_type(schema: dict[str, Any]) -> str:
    if "$ref" in schema:
        return reference_name(schema["$ref"])
    if "const" in schema:
        return literal(schema["const"])
    if "enum" in schema:
        return " | ".join(literal(value) for value in schema["enum"])
    if "anyOf" in schema:
        return " | ".join(ts_type(item) for item in schema["anyOf"])
    if "oneOf" in schema:
        return " | ".join(ts_type(item) for item in schema["oneOf"])
    if "allOf" in schema:
        return " & ".join(ts_type(item) for item in schema["allOf"])

    schema_type = schema.get("type")
    if schema_type == "array":
        item_type = ts_type(schema.get("items", {}))
        return f"Array<{item_type}>"
    if schema_type == "object" or "properties" in schema:
        properties = schema.get("properties", {})
        required = set(schema.get("required", []))
        if properties:
            fields = [
                f"{json.dumps(name)}{'?' if name not in required else ''}: {ts_type(value)};"
                for name, value in properties.items()
            ]
            return "{ " + " ".join(fields) + " }"
        additional = schema.get("additionalProperties")
        if isinstance(additional, dict):
            return f"Record<string, {ts_type(additional)}>"
        return "Record<string, unknown>"
    if schema_type in {"integer", "number"}:
        return "number"
    if schema_type == "boolean":
        return "boolean"
    if schema_type == "null":
        return "null"
    if schema_type == "string":
        return "string"
    return "unknown"


def render_schema(name: str, schema: dict[str, Any]) -> str:
    if schema.get("type") == "object" or "properties" in schema:
        required = set(schema.get("required", []))
        lines = [f"export interface {name} {{"]
        for property_name, property_schema in schema.get("properties", {}).items():
            optional = "" if property_name in required else "?"
            lines.append(f"  {json.dumps(property_name)}{optional}: {ts_type(property_schema)};")
        if not schema.get("properties") and isinstance(schema.get("additionalProperties"), dict):
            lines.append(f"  [key: string]: {ts_type(schema['additionalProperties'])};")
        lines.append("}")
        return "\n".join(lines)
    return f"export type {name} = {ts_type(schema)};"


def generate() -> str:
    schema = app.openapi()
    components: dict[str, dict[str, Any]] = schema.get("components", {}).get("schemas", {})
    digest = hashlib.sha256(json.dumps(schema, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]
    blocks = [
        "/* eslint-disable */",
        "// Generated from FastAPI OpenAPI. Do not edit by hand.",
        f"// Schema digest: {digest}",
        "",
    ]
    blocks.extend(render_schema(name, value) + "\n" for name, value in sorted(components.items()))
    return "\n".join(blocks).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    content = generate()
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text(encoding="utf-8") != content:
            print(f"Generated API types are stale: {OUTPUT}")
            return 1
        print("Generated API types are current.")
        return 0
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(content, encoding="utf-8", newline="\n")
    print(f"Wrote {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
