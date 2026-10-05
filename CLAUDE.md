# Thunderdome

Agents compete on each task, and the best change ships.

The day-by-day build plan is in `PLAN.md`. API notes are in `docs/api-notes.md`.

## How it works

1. You give one task.
2. Thunderdome forks the repo 3 to 5 times, one fork for each agent. All agents work at the same time.
3. Each push makes a Workers Preview (a live test copy of the app).
4. A judge agent runs the tests on each fork and gives it a score. It writes why it chose the winner.
5. The winner merges. The "why" stays with the commit. The other forks stay as a record.

Thunderdome also has a **claim board**. Before an agent starts, it writes which files it will change. The other agents can see this, so most conflicts stop before they start.

## Why this can win

- It answers the 4 questions in the post: who works on what, conflicts, too much to review, and "why."
- It is not "GitHub plus agents." There is no pull request. A contest replaces it.
- It uses all the new parts: the fork binding, push events, Workers Previews, and metrics.
- The 5 to 10 minute video is easy to watch: 5 agents race on a scoreboard.
- It is close to our agent eval product. The judge part can be used again there.

## Rules to know

- The deadline is **October 14, 2026**.
- We must send a 5 to 10 minute video, open source code (MIT, Apache, or BSD — this repo is MIT), and steps to run it.
- We need the Workers Paid plan. Artifacts billing starts October 15.
- Prize: a trip to Cloudflare Connect for the top 3 teams, and $25,000 in credits for first place.
