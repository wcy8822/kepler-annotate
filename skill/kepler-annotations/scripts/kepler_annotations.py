#!/usr/bin/env python3
"""调用插件目录中的唯一 CLI 实现。"""
from pathlib import Path
import runpy

runpy.run_path(str(Path(__file__).resolve().parents[3] / 'kepler-annotations.py'), run_name='__main__')
