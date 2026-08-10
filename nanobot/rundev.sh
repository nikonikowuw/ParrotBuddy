#!/bin/bash
# 启动 nanobot WebUI。使用仓库内 testdir/config.json(含已配置的模型预设),
# 而不是硬编码的其他机器路径(不存在时会回退到空配置 ~/.nanobot/config.json)。
cd "$(dirname "$0")"

export http_proxy=http://127.0.0.1:7890
export https_proxy=http://127.0.0.1:7890
export no_proxy="127.0.0.1,localhost"

uv run nanobot webui --config testdir/config.json
