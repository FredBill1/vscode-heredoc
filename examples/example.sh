#!/usr/bin/env bash

# 预设：Python。引号阻止 shell 在运行时展开正文。
python3 <<'PY'
from pathlib import Path
print(Path.cwd())
PY

# 预设：YAML。<<- 允许结束 delimiter 前面有 TAB。
cat <<-YAML
name: heredoc
enabled: true
	YAML

# 同一命令可排队处理多个 heredoc。
cat <<JSON <<SQL
{"ready": true}
JSON
SELECT 1;
SQL

# 嵌套 shell 中的 heredoc 会继续按其 delimiter 解析。
bash <<'SH'
cat <<'TS'
const answer: number = 42;
TS
SH

# 自定义规则示例：在 settings.json 中将 CONFIG 映射到 yaml。
cat <<'CONFIG'
service: demo
replicas: 2
CONFIG
