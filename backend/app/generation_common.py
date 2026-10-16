from __future__ import annotations

from dataclasses import dataclass

from .models import AIProviderConfig, ProjectFile, RegisteredModel
from .stores import find_provider, find_registered_model


@dataclass(frozen=True)
class RoutedModel:
    provider: AIProviderConfig
    registered: RegisteredModel


def resolve_routed_model(project: ProjectFile, route_key: str, label: str) -> RoutedModel:
    model_id = getattr(project.settings.modelRouting, route_key, None)
    if not model_id:
        raise ValueError(f"No {label} model is selected in project settings.")

    registered_model = find_registered_model(model_id)
    if registered_model is None or not registered_model.enabled:
        raise ValueError(f"{label.capitalize()} model is not registered or enabled: {model_id}")

    provider = find_provider(registered_model.providerId)
    if provider is None:
        raise ValueError(f"Provider is not registered: {registered_model.providerId}")

    return RoutedModel(provider=provider, registered=registered_model)


def language_contract(project: ProjectFile) -> str:
    language = project.settings.defaultLanguage.strip() or "en"
    return f"Write the requested output in project language: {language}."
