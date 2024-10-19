
# Contributing to Free2Z

Welcome to the Free2Z community! We're thrilled to have you contribute to our open-source, community-driven platform. This guide outlines how you can get involved, make a difference, and earn cryptocurrency (Zcash) for your valuable contributions.

All types of contributions are encouraged and valued. See the [Table of Contents](#table-of-contents). Please make sure to read the 'Getting started' section before making your contribution. It will make it a lot easier for us maintainers and smooth out the experience for all involved. 

The community looks forward to your contributions. 🎉

> And if you like the project, but just don’t have time to contribute, that’s fine. There are other easy ways to support the project and show your appreciation, which we would also be very happy about:
> 
> -   Star the project 👉  [![Star on GitHub](https://img.shields.io/github/stars/free2z/zuu.svg?style=social)](https://github.com/free2z/zuu/stargazers)
> -   Tweet about it
> -   Mention the project at local meetups and tell your friends/colleagues

## Table of contents

* [Ways to contribute](#ways-to-contribute)
* [Getting started](#getting-started)
    * [Prerequisites](#prerequisites)
    * [Steps](#steps)
* [Style guide](#style-guide)
    * [Commit messages](#commit-messages)
* [Docs](#docs)
* [Pull requests and code reviews](#pull-requests-and-code-reviews)
* [Getting Help](#getting-help)
* [Cryptocurrency rewards (Zcash)](#cryptocurrency-rewards-zcash)
* [Additional notes](#additional-notes)

## Ways to contribute

Here are several ways you can make a positive impact on Free2Z:

* **Report issues and suggest enhancements:** 
    * Discovered a bug? Have a brilliant idea for a feature? Head over to the issues page 👉 [https://github.com/free2z/zuu/issues](https://github.com/free2z/zuu/issues)
    * Feel free to propose a reward amount for your issue based on its potential impact. 
* **Fix bugs and implement features:**
    * Clone the repository, run the frontend locally, and make your changes. 
    * See the "Running the frontend locally" section below for detailed instructions.
    * Submit your improvements through a well-crafted pull request.

> **Remember:** Only changes that are merged and deployed to production will be eligible for rewards. 

* **Improve the documentation:**
    * Free2Z's documentation is also open-source! You can contribute by following the instructions for the docs app in the "Docs" section below.

## Getting started

### Prerequisites

Ensure you have git, node & npm installed on your system. You can find installation instructions here:

-   git: [https://git-scm.com/downloads](https://git-scm.com/downloads)
-   Node.js/npm: [https://nodejs.org/en](https://nodejs.org/en)

### Steps

1.  Fork the project

<button name="button" onclick="https://github.com/free2z/zuu/fork">Click me to fork</button>

2. Clone your fork locally

```bash
$ git clone https://github.com/free2z/zuu
```
3. Navigate to the frontend directory

```bash
$ cd free2z/ts/react/free2z
```

4. install dependencies

```bash
$ npm i
```

5. Create a new branch
```bash
$ git checkout -b add-my-incredible-feature 
```

6. Start the app 
```bash
$ npm run start
```

This will run the app locally against the test deployment at https://test.free2z.com. Be aware that changes made here are temporary.

> **Important note:** For any changes you want to keep, work against the production domains: free2z.com, free2z.cash, and free2give.xyz.

7. Make your changes

Check the issues section in github to start contributing: https://github.com/free2z/zuu/issues

8. Commit your changes to your local branch with a clear commit message that explains the changes you have made.

```bash
$ git add .
```
```bash
$ git commit -m 'feat(tz/react/free2z) Implemented new feature.'
```

9. Push your changes to your forked repository on GitHub using the following command:
```bash
$ git push origin add-my-incredible-feature
```
10. Create a pull request to the original repository.

Describe the changes you have made and why they are necessary. The project maintainers will review your changes and provide feedback or merge them into the main branch.


## Style guide
### Commit messages

1. Use conventional commits format:

    - Begin with a type (feat, fix, docs, style, refactor, perf, test, chore, etc.) followed by the scope of the change in parentheses and a colon.
    - Example: feat(tz/react/free2z): Implemented new feature

2. Include a brief description:

    - After the type and scope, add a brief description of the changes made.
    - Example: docs(py/dj/proj/zuu): add README for zuu backend
3. Use present tense:

    - Write the commit message in the present tense.
    - Example: Update README.md with py and F2Z backend

4. Keep it concise:
    - Limit the commit message to 50 characters or less.

5. Explain the reason:
    - Optionally, add a longer description explaining why the changes were made if necessary

## Docs

The documentation is a separate docusaurus app within the same repository. To contribute to the docs refer to

[docs/about-free2z](https://github.com/free2z/zuu/blob/main/docs/about-free2z) 

Free2Z documentation at https://free2z.com/docs/
  
## Pull requests and code reviews

- All changes to the frontend and documentation apps are submitted through pull requests.
- Your code must pass all tests before changes are considered for merging.
- Merged changes are deployed to the test domain for further review.
- If everything looks good, the changes are merged to production.

## Getting help

Need help getting started? Here are some resources:
  
1. Try GPT-4o in Chat2Z.
2. Ask questions to the Free2Z community.
3. We also recommend reviewing existing issues on GitHub: https://github.com/free2z/zuu/issues

## Cryptocurrency rewards (Zcash)

Free2Z rewards **contributions that make it all the way to production**. The amount varies depending on the impact of the change, **typically ranging from 1-3 ZEC for small improvements**.

Here's how to maximize your rewards:

1. Focus on making high-quality contributions that get merged and deployed.
2. **Don't expect rewards for test-only changes.**

## Additional notes:

- Free2Z is a team of volunteers, so rewards are distributed thoughtfully.
- Feel free to suggest a reward amount for your proposed issue based on its potential impact.
- We appreciate your interest in contributing to Free2Z! Let's build a better, community-driven, and privacy-focused platform together.
- For any privacy or security concerns, you can report them publicly on the issues page or privately at sec@free2z.com.