# Free2Z React App

Welcome to the Free2Z React App! This is the frontend for [free2z.com](https://free2z.com) and [free2z.cash](https://free2z.cash), a community-driven platform where your contributions are valued and rewarded.

## 🚀 Get involved and earn Zcash (ZEC)!

We are thrilled to have you here! Whether you're a seasoned developer or just starting out, there are plenty of ways to contribute and make a difference. Plus, you can earn cryptocurrency (Zcash) for your valuable contributions!

# ⭐ Star the Project

If you find this project useful or interesting, please consider giving it a star on GitHub. Your support helps us grow and reach more contributors!

[![Star on GitHub](https://img.shields.io/github/stars/free2z/zuu.svg?style=social)](https://github.com/free2z/zuu/stargazers)



## Getting Started

Use Node 24.22.2 and the committed npm lockfile. This classic interface retains
Create React App; its older TypeScript peer declaration requires the explicit
install flag used by CI. Build and browser compatibility checks validate this
dependency graph.

```sh
npm ci --legacy-peer-deps
HOST=127.0.0.1 npm start
npm test -- --watchAll=false
npm run test:build-dependencies
npm run build
```

The development server keeps host and cross-origin checks enabled before source
and proxy middleware, including when no backend proxy is configured.

### Generate self-signed local dev certificates (optional)

**Install `mkcert`, a local CA for development certificates**

```sh
brew install mkcert
mkcert -install
```

**Generate local certificate for `free2z.local` and `localhost`**

```sh
bash devcerts.sh
```

## 🚀 Get involved and earn Zcash (ZEC)!

We appreciate your interest in contributing to our open-source platform. Here’s a brief guide to get you started:

### 🛠️ Ways to contribute
- **Report Issues and Suggest Enhancements:** Visit our [issues page](https://github.com/free2z/zuu/issues) to report bugs or suggest new features.
- **Fix Bugs and Implement Features:** Clone the repository, make your changes, and submit a pull request.
- **Improve Documentation:** Contribute to our open-source documentation by following the instructions in the "Docs" section.

### 💡 Ideas and issues

Looking for ideas on where to start? Check out our [issues page](https://github.com/free2z/zuu/issues) for a list of current tasks and feature requests. Feel free to propose your own ideas and submit pull requests!

### 💸 Rewards
Contributions that are merged and deployed to production are eligible for cryptocurrency rewards (Zcash), typically ranging from 1-3 ZEC for small improvements.

For more detailed guidelines, please refer to our [CONTRIBUTING.md](CONTRIBUTING.md) file.

### Dependency reconciliation (issue #1338)

The lock has Express 4.22.3 and body-parser 1.20.9, both of which request
`qs ~6.16.0`. The override moves the resolved qs from 6.16.1 to 6.17.1;
[GHSA-w4cr-vjpx-p82q](https://github.com/ljharb/qs/security/advisories/GHSA-w4cr-vjpx-p82q)
identifies 6.17.0 as fixed. The current Express 4 and body-parser 1 releases
remain in place, rather than changing the dev server's major API. The lock has
no `query-string` or `decode-uri-component` dependency, so query-string 10
(Node >=22, ESM) has no consumer to upgrade and the unused decoder override
is removed. Reassess it if a future graph introduces a consumer: URL decoding
and module compatibility belong to that consumer, not this absent path.
