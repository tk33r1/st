#!/usr/bin/env python3
"""AIモデルIDの正本（config/ai-models.json）を読むための小さな共通モジュール。"""

import json
import os
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
REGISTRY_PATH = REPO_ROOT / 'config' / 'ai-models.json'


def load_registry():
    with REGISTRY_PATH.open(encoding='utf-8') as f:
        return json.load(f)


def model_id(provider, channel, registry=None):
    if registry is None:
        registry = load_registry()
    try:
        value = registry[provider][channel]
    except (KeyError, TypeError) as e:
        raise RuntimeError(f'AIモデル設定が見つかりません: {provider}.{channel}') from e
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f'AIモデルIDが空です: {provider}.{channel}')
    return value.strip()


def model_id_with_override(provider, channel, env_name):
    """ローカル検証用の環境変数があれば優先し、通常は正本の値を返す。"""
    return os.environ.get(env_name, '').strip() or model_id(provider, channel)
