# Kovalsky

> 🚀 Build AI workflows with agent teams.

Kovalsky is an open-source platform for building and running AI employees.  
Instead of chatting with one generic assistant, you coordinate a team of specialized agents through workflows.

<p align="center">
  <a href="https://github.com/hiddenway/kovalsky/releases">⬇️ Download</a> •
  <a href="https://github.com/hiddenway/kovalsky/discussions">💬 Community</a>
</p>

## 📚 Contents

- [🧭 Why Kovalsky](#why-kovalsky)
- [🖼️ Pipeline Builder UI](#pipeline-builder-ui)
- [🧠 Core Idea](#core-idea)
- [🧩 Core Concepts](#core-concepts)
- [🏗️ Architecture](#architecture)
- [⚙️ JSON Examples](#json-examples)
- [⚡ Installation & Run](#installation-and-run)
- [🖥️ Desktop (Electron)](#desktop-electron)
- [🎯 Use Cases](#use-cases)
- [🤝 Contributing](#contributing)
- [📄 License](#license)
- [🌍 Community](#community)

<a id="why-kovalsky"></a>
## 🧭 Why Kovalsky

Most AI tools follow this model:

`User -> AI -> Response`

Kovalsky uses a team model:

`User -> Workflow -> AI Agents -> Result`

✅ Human-like collaboration  
✅ Direct control over each agent  
✅ Workflow-driven execution  
✅ Simple, understandable architecture

<a id="pipeline-builder-ui"></a>
## 🖼️ Pipeline Builder UI

![Pipeline Builder UI demo](./docs/video/exm1.gif)

<a id="core-idea"></a>
## 🧠 Core Idea

Each AI agent behaves like a teammate with a role and responsibilities.
Users define how these agents collaborate and pass context between steps.

Example flow:

```text
User request
   ↓
Research Agent
   ↓
Developer Agent
   ↓
Testing Agent
   ↓
Deployment Agent
```

This makes multi-step tasks easier to manage and scale.

<a id="core-concepts"></a>
## 🧩 Core Concepts

### 👷 Agents (AI Employees)

Agents are autonomous workers responsible for concrete tasks.

Each agent has:

- `role` - responsibility area
- `goal` - target outcome
- `execution environment` - where it runs

Typical roles:

- software engineer
- QA tester
- research analyst
- DevOps engineer

### 🗣️ Direct Communication

You can talk to each agent individually to:

- clarify work
- adjust instructions
- refine results
- correct mistakes

This gives precise control over the workflow process.

### 🔁 Workflows

A workflow is a sequence (or graph) of agents that execute tasks step by step.

Example chain: `Research -> Development -> Testing -> Deployment`

### 🎛️ Execution Model

Users control execution and can:

- run agents manually
- execute workflows
- pass context between steps
- communicate with a specific agent
- monitor results

<a id="architecture"></a>
## 🏗️ Architecture

Kovalsky keeps the architecture intentionally simple:

```text
User
  |
  v
Workflow
  |
  v
Agents
  |
  v
Execution
```

Agents perform tasks and return results back to the workflow.

<a id="json-examples"></a>
## ⚙️ JSON Examples

### Agent Definition

```json
{
  "name": "developer-agent",
  "role": "AI software engineer",
  "goal": "implement features requested in the workflow"
}
```

### Workflow Definition

```json
{
  "workflow": [
    "research-agent",
    "developer-agent",
    "test-agent",
    "deploy-agent"
  ]
}
```

<a id="installation-and-run"></a>
## ⚡ Installation & Run

### 1) One-line Installer (curl | bash)

```bash
curl -fsSL https://raw.githubusercontent.com/hiddenway/kovalsky/main/scripts/install.sh | bash
```

After install:

```bash
kovalsky start
```

`kovalsky start` uses rare default ports and prints them before startup:
- Backend: `http://127.0.0.1:18787`
- UI: `http://127.0.0.1:3764/pipelines`

It also opens the UI URL in your browser automatically (disable with `KOVALSKY_NO_AUTO_OPEN=1`).

Optional uninstall:

```bash
curl -fsSL https://raw.githubusercontent.com/hiddenway/kovalsky/main/scripts/uninstall.sh | bash
```

### 2) Download Prebuilt Release

Use the latest release:
[https://github.com/hiddenway/kovalsky/releases](https://github.com/hiddenway/kovalsky/releases)

### 3) Build and Run from Source

```bash
git clone https://github.com/hiddenway/kovalsky.git
cd kovalsky
nvm use node
pnpm install
```

Run backend (terminal #1):

```bash
nvm use node
pnpm run dev
```

Run UI (terminal #2):

```bash
nvm use node
pnpm --dir ui run dev
```

Open: `http://localhost:3000/pipelines`

Notes:

- Backend default URL: `http://127.0.0.1:8787`
- If a workflow has no workspace, choose a workspace first in the Workflows page.
- If you switch Node versions and get `better-sqlite3` ABI errors:

```bash
nvm use node
pnpm rebuild better-sqlite3
```

<a id="desktop-electron"></a>
## 🖥️ Desktop (Electron)

Local desktop run from source:

```bash
nvm use node
pnpm run electron:dev
```

Build distributables:

```bash
nvm use node
./build.sh
```

Quick package (zip only):

```bash
nvm use node
./build.sh --quick
```

Build artifacts are written to `release/`.

<a id="use-cases"></a>
## 🎯 Use Cases

| Use Case | Agent Team | Goal |
| --- | --- | --- |
| 🛠️ AI Development Team | architect, developer, tester, deployer | Build and deploy a web application |
| ✍️ Content Production | researcher, writer, editor, publisher | Research and publish a blog article |
| 📊 Data Analysis | data collector, analyst, report generator | Analyze company data and produce insights |

<a id="contributing"></a>
## 🤝 Contributing

Contributions are welcome. You can help by:

- creating new agents
- building workflows
- improving architecture
- improving documentation
- reporting bugs

<a id="license"></a>
## 📄 License

Kovalsky is source-available software licensed under the
Functional Source License (`FSL-1.1-Apache-2.0`).

You may use, modify, and self-host the software.

Offering Kovalsky as a competing commercial hosted service is not permitted
until two years after the version is released, after which the code becomes
available under the Apache License 2.0.

<a id="community"></a>
## 🌍 Community

Join discussions:
[https://github.com/hiddenway/kovalsky/discussions](https://github.com/hiddenway/kovalsky/discussions)
