# Mini Insurance Verification & Change-Monitoring Pipeline

Document AI extraction, Validation Agent rule-checking, and Monitoring Agent change-detection with webhook/Slack notification, built with an agentic LLM extraction step plus a stateful Go/Redis diff service.

**Live demo:** https://axle.ashanpraba.com

The demo runs entirely in the browser against seeded data — no API keys,
no accounts, and no external services required.

## Stack

- Python
- LangChain
- Bedrock (or mocked LLM call)
- Go
- Redis
- Slack webhook
- Docker Compose
- Terraform (optional infra stub)

## How it works

- Write a Python FastAPI /extract endpoint that sends raw policy text to an LLM (Bedrock or a mocked prompt) via LangChain and returns structured JSON: carrier, policy_number, coverage_limits, effective/expiration dates.
- A /validate endpoint that checks the extracted JSON against a hardcoded rule (e.g., liability >= $100k) and returns pass/fail with a reason string.
- Write a small Go service that stores the latest extracted JSON per policy_number in Redis, and on each new submission diffs it against the stored version.
- On detecting a field change (e.g., expiration date or coverage limit), have the Go service POST a formatted message to a Slack incoming webhook summarizing what changed.
- Two sample insurance doc text files (same policy, pre/post renewal) and a Makefile target `make demo` that spins up docker-compose (Python service + Redis), runs doc v1 through extract→validate→store, then runs v2 to trigger the diff and Slack alert.
- Optionally include a 10-line Terraform stub declaring an S3 bucket for raw doc storage, just to show AWS/IaC fluency — not required to run live.

## Running locally

```bash
cd src
bash run.sh
```

Then open the printed URL. A prebuilt static version of the UI lives in
`src/web/` and can be opened directly with no server.
