from __future__ import annotations

from .models import ProjectFile


def model_global_prompt(project: ProjectFile, route_key: str, registered_model_id: str | None) -> str:
    if not registered_model_id:
        return ""
    return (project.settings.modelGlobalPrompts.get(route_key, {}).get(registered_model_id) or "").strip()


def apply_model_global_prompt(
    messages: list[dict[str, str]],
    project: ProjectFile,
    route_key: str,
    registered_model_id: str | None,
) -> list[dict[str, str]]:
    prompt = model_global_prompt(project, route_key, registered_model_id)
    if not prompt:
        return messages

    insertion_index = 1 if messages and messages[0].get("role") == "system" else 0
    return [
        *messages[:insertion_index],
        {
            "role": "system",
            "content": (
                "Model-specific global prompt for this project. "
                "Follow it when it does not conflict with the task-specific system instructions:\n"
                f"{prompt}"
            ),
        },
        *messages[insertion_index:],
    ]
