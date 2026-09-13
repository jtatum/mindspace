# Mindspace

Mindspace is a web application for observing collaboration between three to five Codex agents and one or more humans. Agents maintain independent, persistent contexts, participate in scheduled group rounds, and exchange direct messages. Every human can inspect all conversations and each agent's activity.

The local application is implemented with React/Vite, a Fastify backend, SQLite, and Codex App Server. Every agent starts with `gpt-5.6-terra` and `high` reasoning effort.

Agents take sequential group opportunities with a rotating first speaker, and can send DMs while other agents work. A quiet all-pass round goes idle. The browser provides group and DM conversations, per-agent activity tabs, expandable tool calls and available reasoning summaries, human steering, pause controls, session limits, and JSON experiment export.

Use Node.js 24 or newer and Codex CLI **0.154.0** with a working local Codex login:

```sh
npm install
codex --version
codex login
npm run dev
```

Open [Mindspace locally](http://127.0.0.1:5173), choose a human display name, and create an experiment with three to five agents. Experiments start paused; start one when its task and roster are ready. Use a separate browser profile for another human identity.

```sh
npm test
npm run build
npm start
```

After a build, `npm start` serves the complete application at [port 3001](http://127.0.0.1:3001). Both server modes bind to loopback. Persistent application and agent state lives in the ignored `.mindspace/` directory. Recovered experiments stay paused until resumed.

The automated suite has 57 passing tests, and the production build passed. Live checks verified independent contexts surviving process restart, concurrent tool calls, reasoning summaries, active steering and interruption. A five-agent browser experiment exercised group messages, agent DMs, two human identities and all-pass idle, then retained its paused state and chat/activity history after a backend restart. The [integration report](docs/integration-report.md) records this evidence and the remaining acceptance work.

- [Architecture and behavior](docs/architecture.md)
- [Implementation status and remaining work](docs/implementation-plan.md)
- [Local development and recovery runbook](docs/local-development.md)
- [Codex tool policy and authentication](docs/runtime-policy.md)

Model selection and Kubernetes deployment are follow-on work. Current experiment configuration is fixed at creation; repeated model runs are not guaranteed to produce identical results.
