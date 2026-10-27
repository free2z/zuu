# Run the Free2Z website locally

Install Git, Docker, and Docker Compose. Clone the public source repository:

```sh
git clone https://github.com/free2z/zuu.git
cd zuu
docker compose -f build/free2z/compose.yml up --build
```

Open http://localhost:8080. The stack starts PostgreSQL with pgvector, Redis,
the Django API, and the Svelte website. It applies database migrations before
starting the API. Its database and credentials are disposable local development
resources. External providers require your own development configuration.

For backend development without Compose, see [the backend guide](../../../py/free2z/README.md).
Use Node 24.15 or newer for the Svelte development tools:

```sh
cd ts/svelte/free2z
npm ci --ignore-scripts
npm run check
npm test
```

Use `.env.example` to configure local application origins. Keep credentials in
untracked environment files. Each parallel checkout needs separate ports and
database storage.
