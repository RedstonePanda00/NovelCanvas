"""Tolerant JSON previews; final responses still require strict json.loads validation."""
from __future__ import annotations

import json


def partial_json(text: str):
    index = 0

    def whitespace():
        nonlocal index
        while index < len(text) and text[index].isspace():
            index += 1

    def string():
        nonlocal index
        index += 1
        start = index
        safe_end = index
        while index < len(text):
            if text[index] == '"':
                raw = text[start:index]
                index += 1
                return json.loads('"' + raw + '"'), True
            if text[index] == '\\':
                if index + 1 >= len(text):
                    break
                width = 6 if text[index + 1] == 'u' else 2
                if index + width > len(text):
                    break
                index += width
            else:
                index += 1
            safe_end = index
        raw = json.loads('"' + text[start:safe_end] + '"')
        # Do not emit half a surrogate pair as UTF-8 while a unicode escape is streaming.
        return raw.encode('utf-16-le', errors='surrogatepass').decode('utf-16-le', errors='ignore'), False

    def value():
        nonlocal index
        whitespace()
        if index >= len(text):
            return None, False
        token = text[index]
        if token == '"':
            return string()
        if token in '{[':
            is_object = token == '{'
            result = {} if is_object else []
            index += 1
            while True:
                whitespace()
                if index >= len(text):
                    return result, False
                if text[index] == ('}' if is_object else ']'):
                    index += 1
                    return result, True
                key = None
                if is_object:
                    if text[index] != '"':
                        return result, False
                    key, complete = string()
                    whitespace()
                    if not complete or index >= len(text) or text[index] != ':':
                        return result, False
                    index += 1
                item, complete = value()
                if is_object:
                    result[key] = item
                else:
                    result.append(item)
                if not complete:
                    return result, False
                whitespace()
                if index < len(text) and text[index] == ',':
                    index += 1
                    continue
                if index < len(text) and text[index] == ('}' if is_object else ']'):
                    index += 1
                    return result, True
                return result, False
        start = index
        while index < len(text) and text[index] not in ',}] \r\n\t':
            index += 1
        return json.loads(text[start:index]), True

    try:
        return value()[0]
    except (ValueError, IndexError):
        return None


def event_line(event: dict) -> str:
    return json.dumps(event, ensure_ascii=True) + '\n'
