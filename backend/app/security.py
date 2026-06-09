from __future__ import annotations

from typing import Any


SECRET_KEYS = {
    "apiKey",
    "api_key",
    "authorization",
    "Authorization",
    "bearer",
    "Bearer",
    "token",
    "secret",
    "headers",
}


class SecretValidationError(ValueError):
    pass


def assert_no_secrets(data: Any, path: str = "$") -> None:
    if isinstance(data, dict):
        for key, value in data.items():
            current_path = f"{path}.{key}"
            if key in SECRET_KEYS:
                raise SecretValidationError(f"Secret-like key is not allowed in project JSON: {current_path}")
            assert_no_secrets(value, current_path)
    elif isinstance(data, list):
        for index, item in enumerate(data):
            assert_no_secrets(item, f"{path}[{index}]")
