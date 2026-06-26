# How SDE1, SDE2, and SDE3 Work — A Complete Guide

This document covers how software engineers at each level operate day-to-day: how they receive work, how they approach design, how they communicate, and how they grow into the next level.

---

## Starting a Project — All Phases, Start to Finish

This is the complete lifecycle of a software project, from the moment someone has an idea to the moment it's live and being maintained. Each phase covers what happens, who owns it, and what the output is.

---

### Phase 0 — The Idea (Pre-Engineering)

**Who's involved:** PM / Business stakeholder, maybe SDE3  
**SDE1 involvement:** None yet  
**SDE2 involvement:** None yet  
**SDE3 involvement:** Light — consulted for feasibility

Someone — a product manager, a founder, a business lead — identifies a problem or opportunity. They write a **PRD (Product Requirements Document)** or a feature brief. It's not technical yet.

**What's in a PRD:**
- The problem being solved
- Who the user is
- What success looks like (metrics)
- Rough scope / what's in and out
- Timeline expectations

**SDE3's job here:** Read the PRD and immediately ask hard questions. "Is this technically feasible? What's the risk? Does this conflict with anything we're already building?" They may push back on timeline or scope before a single line of code is planned.

**Output:** An approved PRD that engineering can work from.

---

### Phase 1 — Technical Discovery & Feasibility

**Who's involved:** SDE3 (leads), SDE2s (contribute)  
**SDE1 involvement:** Usually none  
**Duration:** 1–2 weeks for a medium project

This is where engineering first seriously engages. Before designing anything, you need to understand the problem deeply.

**What happens:**
- SDE3 reads the PRD and maps it to the existing system. What breaks? What needs to change? What's missing?
- **Spike tasks** are created — small, time-boxed explorations to answer specific unknowns. Example: "Can our current database handle 10x write volume for this feature? Spend 2 days finding out."
- SDE2s run spikes and report findings.
- The team builds a **shared understanding** of constraints: performance, security, compliance, existing tech debt.

**Key questions answered in this phase:**
- What existing systems are affected?
- Are there third-party dependencies (APIs, vendors)?
- What are the data storage requirements?
- Is there a compliance/security concern?
- What's the realistic timeline (vs. the PM's wishlist)?

**Output:** A **Feasibility Report** or discovery notes. Sometimes this changes the PRD entirely.

---

### Phase 2 — System Design & Architecture

**Who's involved:** SDE3 (owns), SDE2s (review and contribute)  
**SDE1 involvement:** Reads the final doc to understand context  
**Duration:** 1–2 weeks

This is where the technical blueprint is drawn. SDE3 writes an **RFC (Request for Comments)** — a high-level architectural design.

**What an RFC covers:**

```
1. Problem Statement
2. Goals & Non-Goals
3. High-Level Architecture Diagram
4. Service / component breakdown
5. Data flow (how does data move through the system?)
6. API surface (what endpoints/events/contracts are exposed?)
7. Database schema changes
8. Scalability & performance considerations
9. Security considerations
10. Failure modes (what happens when X goes down?)
11. Alternatives considered and why rejected
12. Open questions
```

**The RFC review process:**
1. SDE3 shares the draft RFC in an engineering channel.
2. 48–72 hours async review — engineers leave comments, ask questions, raise concerns.
3. A **Design Review meeting** is held (60–90 min). Key stakeholders attend — SDE2s, platform/infra team if relevant, security if needed.
4. Feedback is incorporated.
5. RFC is marked **approved** — this is the technical contract the team builds against.

**SDE2's role here:** Push back on things that seem overly complex. Raise concerns about parts they own. Ask "how will this affect our service X?"

**Output:** Approved RFC with architecture diagrams, data model, and API contracts.

---

### Phase 3 — Detailed Design (Feature-Level TDDs)

**Who's involved:** SDE2 (owns), reviewed by SDE3  
**SDE1 involvement:** May write TDD for a specific subtask  
**Duration:** 3–5 days per feature

Once the architecture is agreed on, SDE2s take ownership of individual features/components and write **TDDs (Technical Design Documents)** — the detailed implementation plan.

**TDD vs RFC:**
- RFC = "what are we building and how does it fit together?"
- TDD = "how exactly will I build this specific feature?"

**What a TDD covers:**
- Class/module design
- Function signatures and data contracts
- Database queries and indexes
- Error handling logic
- Edge cases and how each is handled
- Testing strategy (unit, integration, E2E)
- Migration plan (if changing existing behavior)

**SDE1's TDD (when assigned):** Narrower scope — just their specific subtask. Example: "How will I implement the retry logic for failed webhook deliveries?"

**Output:** Approved TDDs for each feature. Work can now begin.

---

### Phase 4 — Project Planning & Estimation

**Who's involved:** SDE2 (drives), SDE3 (validates), PM (coordinates)  
**SDE1 involvement:** Estimates their own tasks  
**Duration:** 1–2 days

Before writing code, the work is broken into **tickets** (in Jira, Linear, GitHub Issues, etc.).

**SDE2's job:**
- Break the TDD into discrete, implementable tasks.
- Each task should be completable in 1–3 days max. If it's larger, break it down further.
- Identify **dependencies** — what must be done before what?
- Write acceptance criteria on each ticket (how do you know it's done?).
- Estimate effort (story points or hours — whatever the team uses).

**SDE3's job:**
- Validate that estimates are realistic.
- Flag anything that seems underestimated (the classic "that's actually 3x harder than it looks").
- Identify the **critical path** — the sequence of tasks where a delay causes the whole project to slip.

**What a well-written ticket looks like:**
```
Title: Implement retry queue for failed webhook deliveries

Context: When a webhook fails, we need to retry with exponential backoff

Acceptance Criteria:
- Failed webhooks are re-queued automatically
- Retry attempts: 3, with delays of 1m, 5m, 30m
- After 3 failures, event is moved to dead-letter queue
- Metrics emitted for retry count per event

Dependencies: Ticket #45 (Dead-letter queue setup) must be done first

Estimate: 2 days
```

**Output:** Sprint-ready backlog with sized, prioritized, dependency-mapped tickets.

---

### Phase 5 — Implementation

**Who's involved:** SDE1 + SDE2 (write code), SDE3 (spot-checks, unblocks hard problems)  
**Duration:** Bulk of the project timeline

This is where the actual building happens. It follows a cadence:

**Daily rhythm:**
1. Pull the top ticket from the sprint board.
2. Create a feature branch off `main` (or `develop`).
3. Build, write tests as you go — not after.
4. Open a PR when done (or a draft PR early for feedback on direction).
5. Address review comments.
6. Merge. Move ticket to Done.

**SDE1's implementation approach:**
- Follow the TDD exactly unless something doesn't work — then flag it, don't silently deviate.
- Write tests for the happy path first, then edge cases.
- Ask for help at 2-hour block limit — don't burn a day on something an SDE2 can answer in 10 minutes.

**SDE2's implementation approach:**
- Build the core/shared pieces first (the things SDE1s will depend on).
- Keep SDE1s unblocked — their blockers are your priority.
- Keep PRs small and frequent. "Draft PR early" is the way.
- Update the TDD if reality diverges from the plan.

**SDE3's implementation approach:**
- Mostly not writing code — reviewing, unblocking, guiding.
- Steps in when there's a hard problem (performance, concurrency, security).
- Does periodic **tech health checks** — is the implementation matching the RFC?

**Branch strategy (common):**
```
main (production)
  └── develop (integration)
        └── feature/webhook-retry (SDE1/SDE2 work here)
        └── feature/dead-letter-queue
        └── feature/metrics-dashboard
```

**Output:** Working, tested code in PRs, merged into the integration branch.

---

### Phase 6 — Code Review

**Who's involved:** SDE2 reviews SDE1 PRs, SDE3 reviews SDE2 PRs (and spot-checks SDE1)  
**Duration:** Ongoing throughout Phase 5

Code review is not a formality — it's a quality gate and a teaching mechanism.

**What reviewers check:**
- Does it solve the problem correctly?
- Does it match the TDD / RFC design?
- Are there edge cases not handled?
- Is it readable? Will a new teammate understand this in 6 months?
- Are tests meaningful, not just coverage-padding?
- Are there performance issues (N+1 queries, missing indexes, unnecessary allocations)?
- Are secrets/credentials handled safely?
- Is error handling consistent with the team's conventions?

**Review SLAs (what healthy teams target):**
- PRs < 400 lines: reviewed within 4 hours
- PRs > 400 lines: reviewed within 1 business day
- Blocking comments must be addressed before merge
- Non-blocking (Nit:) comments are author's discretion

**Output:** Reviewed, approved, merged PRs.

---

### Phase 7 — Integration Testing & QA

**Who's involved:** SDE2 (owns), QA team (if exists), SDE1 (fixes bugs)  
**Duration:** 1–2 weeks

Once features are merged into the integration branch, the system is tested as a whole.

**Types of testing in this phase:**

- **Integration tests:** Does component A work with component B as expected?
- **End-to-end (E2E) tests:** Simulate real user flows from start to finish.
- **Load/stress testing:** What happens at 5x normal traffic? At 10x?
- **Security testing:** Are there injection vulnerabilities? Are auth boundaries correct?
- **Regression testing:** Did we break anything that was already working?

**SDE2's job:** Write and run integration tests. Fix any integration issues (often different from unit-level bugs — things like serialization mismatches, race conditions, config issues in staging).

**SDE1's job:** Fix the bugs found in their features. Update tests accordingly.

**SDE3's job:** Review load test results. Make the call on whether performance is acceptable or needs work before launch.

**Output:** Stable build on staging environment. Known bugs triaged (P0/P1 fixed, P2/P3 scheduled for later).

---

### Phase 8 — Staging & Pre-Launch Checklist

**Who's involved:** SDE2 (owns), SDE3 (signs off), DevOps/Platform  
**Duration:** 3–5 days

The code is on staging. Before going to production, the team runs through a checklist:

```
Pre-Launch Checklist:
□ All P0/P1 bugs fixed
□ Feature flags configured in production config
□ Database migrations tested on staging (and have a rollback script)
□ Runbook written: how to operate this feature, how to debug it
□ Alerts configured: what gets paged? At what threshold?
□ Dashboards set up: what metrics tell us it's healthy?
□ On-call rotation updated: who's responsible post-launch?
□ Rollback plan documented: how do we turn this off if it breaks?
□ Data privacy review done (if handling user data)
□ Documentation updated (API docs, internal wiki)
□ PM signed off on staging demo
```

**Output:** Launch-ready build. Rollback plan in hand.

---

### Phase 9 — Deployment & Rollout

**Who's involved:** SDE2 (executes), SDE3 (on standby), DevOps  
**Duration:** Hours to days depending on rollout strategy

**Rollout strategies:**

- **Feature flag / dark launch:** Code ships but feature is off. Turn it on for internal users first, then a % of real users.
- **Canary release:** Deploy to 5% of servers, watch metrics for 30 min, then expand.
- **Blue-green deployment:** Run old and new versions in parallel. Switch traffic. Keep old version hot for instant rollback.
- **Full deploy:** All or nothing. Only for small, low-risk changes.

**What SDE2 does during deploy:**
- Watch error rate dashboards in real time.
- Watch latency metrics.
- Watch business metrics (conversion, API success rate, etc.).
- Have rollback command ready in a separate terminal.

**The "is it healthy?" check (first 30 minutes post-deploy):**
- Error rate: same as pre-deploy? ✅
- Latency p50/p95/p99: same or better? ✅
- Database query time: normal? ✅
- Queue depth (if async): not growing unboundedly? ✅

**If something looks wrong:** Roll back first, investigate second. Never debug in production with real traffic taking the hit.

**Output:** Feature live in production. Metrics green.

---

### Phase 10 — Post-Launch Monitoring

**Who's involved:** SDE2 (owns), SDE1 (assists), on-call rotation  
**Duration:** First 2 weeks after launch are high-attention

**What to watch:**

- **Error rates:** Any new error patterns? Any 5xx spikes?
- **Latency:** Is the new feature slower than expected under real load?
- **Business metrics:** Is the feature actually working? (e.g., webhook delivery success rate)
- **Infrastructure cost:** Did this feature unexpectedly spike database or compute costs?
- **User feedback:** Any complaints coming through support?

**SDE2's job:** Own the on-call rotation for the new feature's first 2 weeks. Be reachable. Have the runbook open.

**SDE1's job:** Help debug issues as they come in. Be available during business hours.

**SDE3's job:** Review the weekly metrics summary. Decide if any architectural changes are needed based on real-world usage patterns.

**Output:** Stable, monitored feature in production. Alerts tuned to real noise levels.

---

### Phase 11 — Post-Mortem & Retrospective

**Who's involved:** Whole team  
**Duration:** 1–2 hour meeting + doc

After every significant launch (especially ones that had incidents), the team does two things:

**Post-mortem** (if there was an incident):
- What happened? (Timeline of events)
- Why did it happen? (Root cause, not blame)
- What was the user/business impact?
- How did we detect it? How long did it take?
- What would have caught this earlier?
- Action items with owners and deadlines

**Retrospective** (every team, every sprint/project):
- What went well? (Repeat this)
- What didn't go well? (Fix this)
- What are we confused about? (Investigate this)
- Action items

**Output:** Written post-mortem (shared org-wide for learning). Retro action items in the backlog.

---

### The Full Project Timeline at a Glance

```
Phase 0  — Idea & PRD                    [PM]                 Week 1
Phase 1  — Technical Discovery           [SDE3 + SDE2]        Week 2–3
Phase 2  — System Design (RFC)           [SDE3]               Week 3–4
Phase 3  — Detailed Design (TDDs)        [SDE2]               Week 4–5
Phase 4  — Planning & Ticketing          [SDE2 + SDE3]        Week 5
Phase 5  — Implementation                [SDE1 + SDE2]        Week 6–10
Phase 6  — Code Review                   [SDE2 + SDE3]        Week 6–10 (ongoing)
Phase 7  — Integration Testing & QA      [SDE2 + QA]          Week 10–11
Phase 8  — Staging & Pre-Launch          [SDE2 + SDE3]        Week 11–12
Phase 9  — Deployment & Rollout          [SDE2]               Week 12
Phase 10 — Post-Launch Monitoring        [SDE2]               Week 13–14
Phase 11 — Post-Mortem & Retro           [Full team]          Week 14
```

> Note: These timelines are illustrative for a medium-complexity project (1–2 SDE2s, 1–2 SDE1s, 6–8 weeks of implementation). Small features skip phases 1–3. Large platform initiatives may spend months in phases 1–3 alone.

---

### What Each Level Owns Across the Full Lifecycle

| Phase | SDE1 | SDE2 | SDE3 |
|---|---|---|---|
| PRD / Idea | — | Reads | Consults |
| Technical Discovery | — | Runs spikes | Leads |
| System Design (RFC) | Reads | Reviews | **Owns** |
| Detailed Design (TDD) | Writes narrow TDD | **Owns** | Reviews |
| Planning & Ticketing | Estimates own tasks | **Owns** | Validates |
| Implementation | **Owns** (their tickets) | **Owns** + unblocks SDE1 | Spot-checks |
| Code Review | Responds | **Owns** (reviews SDE1) | Reviews SDE2 |
| Integration Testing | Fixes bugs | **Owns** | Reviews results |
| Staging & Pre-launch | — | **Owns** | Signs off |
| Deployment | Watches | **Owns** | On standby |
| Post-launch monitoring | Assists | **Owns** | Reviews weekly |
| Post-mortem & Retro | Participates | Participates | Facilitates |

---

## The Mental Model First

Before the specifics, understand the gradient:

| Level | Core Question They Answer |
|---|---|
| SDE1 | "How do I implement this?" |
| SDE2 | "What should we implement, and how?" |
| SDE3 | "What should we build, and why does it matter to the business?" |

An SDE1 executes well-defined tasks. An SDE2 defines *and* executes. An SDE3 shapes the problem space itself.

---

## SDE1 — The Learner-Executor

### Who They Are

SDE1s are early in their career — typically 0–2 years of experience. They have solid fundamentals but are still building judgment. They need guidance to translate business needs into working software.

### First Step When Given a Task

1. **Read the ticket/issue fully.** Understand acceptance criteria before writing a single line.
2. **Ask clarifying questions early.** It is far better to ask now than to build the wrong thing.
3. **Explore the codebase** — find where similar things are done, read related files, understand conventions.
4. **Write a rough plan** (even in comments or a notepad) before coding.
5. **Timebox uncertainty.** If stuck for more than 2 hours, escalate to SDE2 or manager.

### Day-to-Day Workflow

- Pull assigned tickets from the sprint backlog.
- Attend standups, share blockers clearly: *"I'm working on X, blocked by Y, need help with Z."*
- Write code, run tests locally, open a PR.
- Respond to code review comments promptly — treat feedback as learning, not criticism.
- Merge only after approval; never force-merge.
- Close the ticket and update status.

### What "Design" Looks Like at SDE1

SDE1s are mostly **consumers** of the design system, not contributors. When building a feature:

- Follow existing patterns in the codebase — naming conventions, file structure, component/module boundaries.
- Don't invent new abstractions unless explicitly asked to.
- If something doesn't fit cleanly, raise it in the PR or with their SDE2 — don't silently force it.

They may be asked to write a **mini design doc** for a non-trivial subtask. This is usually 1–2 pages: the problem, the approach, edge cases considered.

### Communication Style

- **With manager:** Weekly 1:1s. Raise blockers proactively. Share what they've learned.
- **With SDE2:** Daily/ad-hoc. Ask questions without shame. Use Slack/Teams DMs for quick unblocks.
- **In PRs:** Write clear PR descriptions — what changed, why, how to test. Link the ticket.
- **In standups:** Be specific. "Working on the auth bug from ticket #123, should be done today" beats "still coding."

### Common Pitfalls to Avoid

- Going silent when blocked (the silent struggle trap).
- Overengineering simple tasks to prove skill.
- Skipping tests because "it's a small change."
- Waiting to be told every single next step.

---

## SDE2 — The Reliable Contributor

### Who They Are

SDE2s are mid-level engineers — typically 2–5 years of experience. They can own features end-to-end, make independent technical decisions, and are starting to influence others. They are the backbone of most engineering teams.

### First Step When Given a Task

1. **Understand the *why* behind the task** — business context, user impact, metrics it will move.
2. **Scope it.** Break it into subtasks. Identify what's risky or unclear.
3. **Write a design doc** for anything non-trivial (see below).
4. **Share the plan with the team** before building — get alignment, especially for anything touching other teams.
5. **Assign subtasks** (to themselves or SDE1s) and track progress.

### Day-to-Day Workflow

- Own a feature/component from requirements → design → implementation → testing → deployment → monitoring.
- Unblock SDE1s on their team — answer questions, pair program when needed.
- Review PRs from peers with constructive, educational feedback.
- Participate actively in sprint planning — give effort estimates, flag dependencies.
- Write runbooks, update documentation when shipping something.
- Monitor alerts/metrics post-deploy.

### What "Design" Looks Like at SDE2

SDE2s write **proper design docs** (also called TDDs — Technical Design Documents or RFCs — Request for Comments).

**Structure of a typical SDE2 design doc:**

1. **Problem Statement** — What's broken or missing? What's the user impact?
2. **Goals & Non-Goals** — What this solves and explicitly what it doesn't.
3. **Proposed Solution** — The approach, with diagrams if needed (sequence diagrams, ERDs, architecture sketches).
4. **Alternatives Considered** — At least 2 other approaches and why they were rejected.
5. **Data Model Changes** — New tables, fields, schema migrations.
6. **API Contract** — New or changed endpoints, request/response shapes.
7. **Edge Cases & Error Handling** — What can go wrong, how it's handled.
8. **Testing Plan** — Unit, integration, E2E tests. Load testing if needed.
9. **Rollout Plan** — Feature flags, gradual rollout, rollback strategy.
10. **Open Questions** — Things still unresolved, waiting for input.

The doc is shared in a channel or meeting for review, feedback is incorporated, then work starts.

### Communication Style

- **With manager:** Weekly 1:1s. Proactively share progress, surface risks early, bring solutions not just problems.
- **With SDE1s:** Mentoring. Explain the *why* behind feedback, not just the *what*. Pair program, not just review.
- **With SDE3/Staff:** Sync before making big technical decisions. Use their design review as a forcing function for thinking clearly.
- **Cross-team:** Slack/email for async coordination. Calendar invite for anything requiring alignment from multiple teams.
- **In incidents:** Own the investigation, write the post-mortem, present findings.

### Common Pitfalls to Avoid

- Under-documenting — building things that only they understand.
- Over-mentoring — doing the work for the SDE1 instead of teaching.
- Saying yes to everything without pushing back on scope.
- Skipping design docs for "quick" features that end up being messy.

---

## SDE3 — The Technical Leader

### Who They Are

SDE3s (also called Senior Engineers or Staff Engineers depending on the company) operate at a different altitude. They think in systems, not features. They have 5+ years of experience and their decisions affect the entire team's velocity — sometimes the whole org's.

They are often the ones setting technical direction, driving architecture decisions, and ensuring the team doesn't accrue crippling technical debt.

### First Step When Given an Initiative

1. **Question the framing.** "Is this the right problem to solve? Is this the right time?"
2. **Map stakeholders.** Who cares about this? Product, data, platform, security, legal?
3. **Define success metrics.** What does "done" look like in 3 months? 6 months?
4. **Write an RFC** — a broad, collaborative design document shared with the team and adjacent teams.
5. **Identify the highest-risk unknowns** and spike on those first (build a small proof of concept, not the full thing).
6. **Set the technical vision** for the initiative, then delegate implementation to SDE1/SDE2.

### Day-to-Day Workflow

- Attend (and often run) architecture review meetings.
- Review design docs from SDE2s — not to approve every decision, but to catch systemic issues.
- Write RFCs for large cross-cutting changes (auth systems, data pipelines, service boundaries).
- Engage with product/PM on roadmap discussions — push back on technically infeasible timelines.
- Handle escalations from SDE1/SDE2 when a decision requires broader context.
- Improve the team's engineering culture — coding standards, testing philosophy, deployment practices.
- Drive technical interviews, define what "good" looks like in hiring.

### What "Design" Looks Like at SDE3

SDE3s think about **systems**, not just features:

- **Service boundaries** — should this be a new microservice or part of an existing one? What are the tradeoffs?
- **Data architecture** — relational vs. event-sourced? How does this data flow through the system?
- **Scalability** — what happens at 10x load? What breaks first?
- **Operational excellence** — how do we observe this? What alerts exist? What's the on-call story?
- **Migration paths** — how do we move from the current state to the future state without breaking users?

An SDE3's design doc (RFC) often doesn't describe implementation — it describes **principles and constraints** that implementations must satisfy.

### Communication Style

- **With manager/director:** Strategic alignment. Talk in terms of business impact, team health, and 6–12 month horizon.
- **With SDE2s:** Design review, not code review. Ask "have you considered X?" not "change this to Y."
- **With SDE1s:** High-signal, rare — mostly through code reviews, design feedback, or impromptu teaching moments.
- **Cross-team / cross-org:** Often the single point of contact for technical decisions that span teams. Write things up for async consumption. Don't hoard knowledge.
- **With Product:** Say "no, here's why, here's an alternative" rather than just "yes" or "no." Be a partner, not an order-taker.

### Common Pitfalls to Avoid

- Getting pulled into implementation details that SDE2 can handle (staying too tactical).
- Making unilateral decisions without socializing first (creating resentment).
- Treating all problems as technical (sometimes the problem is process, not code).
- Not delegating enough and becoming a bottleneck.

---

## How All Three Work Together on a Feature

Here's a realistic end-to-end flow for a non-trivial feature:

```
Product Manager writes a PRD (Product Requirements Doc)
        ↓
SDE3 reads it, asks hard questions, shapes the technical approach
        ↓
SDE3 writes an RFC / high-level design doc
        ↓
Design review meeting (SDE3 + SDE2s + relevant stakeholders)
        ↓
SDE2 takes ownership of the feature, writes a detailed TDD
        ↓
TDD review (SDE3 reviews for systemic issues, SDE2 peers review for correctness)
        ↓
SDE2 breaks work into tickets, assigns some to SDE1s
        ↓
SDE1 picks up a ticket, implements, opens PR
        ↓
SDE2 reviews SDE1's PR, gives feedback, approves
        ↓
SDE2 integrates all pieces, writes integration tests
        ↓
SDE3 does a final architecture/code spot-check
        ↓
QA / staging testing
        ↓
SDE2 deploys behind feature flag, monitors
        ↓
Gradual rollout → full release
        ↓
SDE2 writes post-ship doc (metrics, learnings, follow-ups)
```

---

## Communication Channels & When to Use Them

| Channel | Use Case |
|---|---|
| **Slack / Teams DM** | Quick unblocks, async questions, low-stakes coordination |
| **Slack / Teams Channel** | Team-wide announcements, sharing docs for review, incident updates |
| **PR Comments** | Code-level feedback, implementation questions |
| **Design Doc / RFC** | Technical decisions, architecture choices — async, structured |
| **Standup** | Daily status, blockers, short-term coordination |
| **1:1 Meetings** | Career growth, sensitive feedback, escalations |
| **Design Review Meeting** | Synchronous alignment on architecture for complex features |
| **Incident Bridge** | Active production issues — real-time, focused |
| **Post-mortem Doc** | Incident learnings — written, shared broadly |

---

## The Design System: Who Does What

"Design system" here means the technical conventions, patterns, and architecture that the team agrees on.

| Concern | SDE1 | SDE2 | SDE3 |
|---|---|---|---|
| **Follows** conventions | ✅ | ✅ | ✅ |
| **Questions** existing conventions | Sometimes | Often | Always |
| **Proposes** new conventions | Rarely | Sometimes | Frequently |
| **Enforces** via code review | No | Yes | Yes |
| **Evolves** the system | No | Contributes | Drives |
| **Documents** the system | Contributes | Owns | Shapes |

### How a Convention Gets Adopted

1. SDE2 or SDE3 notices a recurring problem (e.g., inconsistent error handling across services).
2. They write a short proposal: current state, problem, proposed standard, migration path.
3. It's shared in an engineering channel or RFC doc for comment.
4. Discussion happens (async or in a meeting). Objections are addressed.
5. Agreement is reached, it's written into a style guide / ADR (Architecture Decision Record).
6. It's enforced via linting, code review, or tooling.
7. SDE1s and new joiners follow it going forward.

---

## Code Review Culture at Each Level

**SDE1 as author:**
- Write a clear PR description. Explain *what* and *why*.
- Keep PRs small (< 400 lines ideally). Big PRs don't get reviewed well.
- Respond to comments within a day. Don't ghost reviewers.
- Don't take feedback personally — every comment is about the code, not you.

**SDE2 as reviewer:**
- Look for correctness first, then clarity, then style.
- Leave educational comments, not just "fix this."
- Approve only when genuinely satisfied, not to be nice.
- Block PRs that introduce tech debt or break patterns, even for seniors.

**SDE3 as reviewer:**
- Rarely review line-by-line. Focus on: does this fit the architecture? Are there systemic risks?
- Ask "have you thought about X?" more than "change this to Y."
- Leave optional suggestions (prefix with "Nit:" or "Optional:") vs. required changes clearly.

---

## How They Grow Into the Next Level

### SDE1 → SDE2

- Consistently delivers without needing supervision.
- Starts anticipating edge cases and raising them proactively.
- Writes design docs independently.
- Gives useful code review feedback (not just style).
- Mentors interns or newer SDE1s.
- Takes ownership of incidents, not just coding tasks.

### SDE2 → SDE3

- Drives entire features end-to-end, including product/design alignment.
- Their technical decisions are consistently right and well-reasoned.
- Improves team velocity — not just their own output.
- Makes architectural decisions that hold up at scale.
- Recognized by other teams as a go-to person for their domain.
- Thinks proactively about what the team *should* build, not just executes what's asked.

---

## Summary

| Dimension | SDE1 | SDE2 | SDE3 |
|---|---|---|---|
| **Scope** | Task | Feature | System / Initiative |
| **Autonomy** | Low | Medium | High |
| **Design depth** | Implementation | Full TDD | RFC + Architecture |
| **Communication** | Within team | Team + adjacent | Cross-org |
| **Mentoring** | Receives | Gives (SDE1s) | Shapes culture |
| **Ambiguity tolerance** | Low | Medium | High |
| **On-call ownership** | Supports | Owns | Sets the standard |
| **Business awareness** | Basic | Growing | Strong |

The most important thing to understand: **these levels aren't about seniority of knowledge alone — they're about scope of impact and ownership.** An SDE3 who only writes code is underperforming. An SDE1 who asks good design questions is growing fast.
