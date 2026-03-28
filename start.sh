#!/bin/bash
set -e

export API_PORT=3000
export PORT=5000
export BASE_PATH=/

cd /home/runner/workspace/artifacts/api-server
PORT=$API_PORT pnpm run dev &
API_PID=$!

cd /home/runner/workspace
PORT=$PORT BASE_PATH=$BASE_PATH API_PORT=$API_PORT pnpm --filter @workspace/sui-dex run dev

wait $API_PID
