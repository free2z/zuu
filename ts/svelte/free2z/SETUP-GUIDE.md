# Free2z local setup 

This guide quickly takes you through setting up the project locally (backend + frontend).

> If you only want the frontend or backend running, follow the relevant section below.

---

## Prerequisites ⚙️

- Git
- Docker
- Node.js (v16+) and npm
- Python 3

---

## Quick Steps

1. Clone the repo and checkout the `new-ui` branch
2. Start a local Postgres container and restore the `free2z` dump to seed the db
3. Configure `settings.py` and install Python dependencies
4. Run Django migrations and start the backend
5. Get yourself some `tuzis` 
6. Start the frontend

---

## 1) Clone the repo and checkout branch

Open a terminal, then:

```zsh
git clone git@github.com:free2z/tuzi.git
```

```zsh
cd tuzi
```

```zsh
git checkout new-ui
```

---

## 2) Start Postgres and restore database dump 🐘

We're using `pgvector` with **Postgres 16** so the vector extension is available. If you already have a Postgres setup, point your Django settings to it instead.

1) Create and run the Postgres container:

```zsh
docker run -d --name postgres-free2z \
  -e POSTGRES_DB=testdb \
  -e POSTGRES_USER=dbuser \
  -e POSTGRES_PASSWORD=Testing321 \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

2) Create the vector extension inside the DB (execute the SQL):

```zsh
docker exec -it postgres-free2z psql -U dbuser -d testdb -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

3) Download the `free2z` SQL dump and copy it into the container. If you already have a `free2z_dump.sql` file in the repo or a path on your machine, point to it; otherwise ask the mantainers of the repo for it.


> Assuming the dump is in your local checkout

```zsh
docker cp free2z_dump.sql postgres-free2z:/tmp/
```

```zsh
docker exec -i postgres-free2z bash -c "psql -U dbuser -d testdb -f /tmp/free2z_dump.sql"
```

---

## 3) Configure Django settings & environment 🌍

Update the Django `settings.py`  (py/dj/free2z) to point to the local DB. Example connection parameters:

```python
# ALLOWED_HOSTS
ALLOWED_HOSTS = [
    'localhost',
    '127.0.0.1',
    '[::1]',  # IPv6 localhost
    'https://test.free2z.com'
]
```

```python
# CORS origins for local/dev usage
CORS_ORIGIN_WHITELIST = [
    'https://free2z.cash',
    'https://free2give.xyz',
    'http://localhost:3000',
    'http://localhost:5173',  # SvelteKit dev server
    'http://localhost:8000',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',  # SvelteKit dev server
    'http://127.0.0.1:8000',
    'test.free2z.com',
]
```

```python
# CSRF trusted origins for local/dev usage
CSRF_TRUSTED_ORIGINS = [
    'http://localhost:3000',
    'https://localhost:3000',
    'http://localhost:5173',  # SvelteKit dev server
    'https://localhost:5173',  # SvelteKit dev server
    'http://localhost:8000',
    'https://localhost:8000',
    'http://127.0.0.1:3000',
    'https://127.0.0.1:3000',
    'http://127.0.0.1:5173',  # SvelteKit dev server
    'https://127.0.0.1:5173',  # SvelteKit dev server
    'https://127.0.0.1:8000',
    'http://127.0.0.1:8000',
    'https://test.free2z.com',
]
```

```python
# DATABASES
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': 'testdb',
        'USER': 'dbuser',
        'PASSWORD': 'Testing321',
        'HOST': '127.0.0.1',
        'PORT': '5432',
    }
}
```

```python
# LOGGING
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'handlers': {
        'console': {
            'class': 'logging.StreamHandler',
        },
    },
    'root': {
        'handlers': ['console'],
        'level': 'DEBUG',
    },
}
```

Recommended settings changes while developing:
- Turn `DEBUG = True` in your local settings
- Configure allowed hosts and CORS if needed for the UI dev server
---

## 4) Install Python dependencies and run backend 🐍

```zsh
cd py
python3 -m venv env
source env/bin/activate
export PYTHONPATH=`pwd`
pip install -r requirements/main.txt
python3 dj/free2z/manage.py migrate
python3 dj/free2z/manage.py runserver
```

---

## 5) Get yourself some `tuzis`

After you have the Postgres container running and the dump loaded, you can update a creator's tuzis (example SQL) to verify the UI shows balance changes. Update `<your_creator_username>` with a real creator's username (string literal in SQL).

```zsh
docker exec -i postgres-free2z psql -U dbuser -d testdb -c "UPDATE g12f_creator SET tuzis = 10000.000 WHERE username = 'your_creator_username' RETURNING id, username, tuzis;"
```

---

## 6) Run the frontend (UI) ⚛️

### 6.1) UI config
The SvelteKit app lives at `ts/svelte/free2z`.
Create (or update) `.env` from `.env.example` in that app directory.

```zsh
cd ts/svelte/free2z
cp .env.example .env
# Make sure the backend URL points to your running Django dev server
# e.g. in .env:
# PUBLIC_API_BASE_URL=http://localhost:8000
```
### 6.2) Run the UI
Open a terminal and run:

```zsh
cd ts/svelte/free2z
npm install
npm run dev
```
---

## Additional dev tips 💡

- Use `git stash` before switching branches and `git status` to ensure no local changes cause path or migration conflicts.

---

## Troubleshooting 🛠️

- 502/400 errors on the UI? Check server logs (`python manage.py runserver`) for missing migrations or DB errors.
- DB migration errors: re-run `python manage.py migrate` and check for missing dependencies.

---
