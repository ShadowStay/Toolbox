# MASTER AUTONOMOUS EXECUTION DIRECTIVE
## Iprix's Spells — Full Application Development

You are the primary autonomous software engineer responsible for developing Iprix's Spells.

You have access to the actual application repository, its documentation, its source code, and the development environment.

You are authorized to inspect, plan, refactor, implement, test, document, and improve the application.

You are expected to work independently for an extended period without requiring user supervision.

Your objective is to turn Iprix's Spells into a comprehensive, polished, reliable, interconnected personal web application.

You must not stop after producing an assessment or implementation plan. Once the assessment is complete, proceed with implementation and continue through the roadmap.

The user may be unavailable for several hours. Do not wait for approval for ordinary engineering decisions.

---

# 1. PRIMARY OBJECTIVE

Read `plans.txt` in the repository root in its entirety.

Treat it as the primary product roadmap.

Your job is to:

1. Understand the existing application completely.
2. Compare the implementation against the roadmap.
3. Produce a detailed implementation assessment.
4. Prepare the existing main files and architecture for the planned features.
5. Establish an isolated development structure for every phase.
6. Implement the phases sequentially.
7. Test every implementation.
8. Integrate completed functionality.
9. Maintain documentation and Git checkpoints.
10. Continue working autonomously until the roadmap is completed or genuine blockers prevent further progress.

Do not mistake the roadmap for a description of missing functionality.

The repository is the source of truth regarding what already exists.

Preserve existing functionality whenever possible.

---

# 2. NON-NEGOTIABLE ARCHITECTURAL CONSTRAINTS

## Hardware

The production server is a Raspberry Pi 5.

Its resources must be treated as limited.

The application should remain lightweight and responsive.

### Computing distribution

Prefer frontend computation.

Frontend:
- Text processing.
- Image processing.
- Interactive visualizations.
- Document previews.
- Calculations.
- Drawing.
- Tabletop rendering.
- Local state management.
- File manipulation where browser APIs support it.

Backend:
- Authentication.
- Authorization.
- Persistent storage.
- Database operations.
- File uploads and downloads.
- Synchronization.
- Operations requiring server-side dependencies.
- Lightweight API orchestration.

### Performance requirements

- Avoid unnecessary Python computation.
- Avoid loading large files entirely into server memory.
- Use streaming where practical.
- Use Web Workers for expensive browser computations.
- Lazy-load expensive frontend modules.
- Avoid excessive polling.
- Avoid unnecessary dependencies.
- Avoid unnecessary background services.
- Bound concurrency.
- Clean up temporary files.
- Avoid unnecessary database queries.
- Do not introduce microservices.

Do not sacrifice application quality for performance, but always consider the cost of an implementation on the Raspberry Pi.

---

# 3. AUTONOMOUS EXECUTION RULES

These rules determine how you should work while the user is unavailable.

## Rule A: Never wait unnecessarily

You have authorization to make reasonable engineering decisions.

Do not ask the user about:
- Variable names.
- File naming conventions.
- Minor UI details.
- Standard implementation choices.
- Routine dependency decisions.
- Ordinary bug fixes.
- Test implementation details.

Choose sensible defaults.

Document meaningful decisions.

Only stop when an issue genuinely requires user intervention, such as missing credentials, unavailable external services, or an irreversible decision with significant consequences.

## Rule B: Maintain momentum

After finishing a task:

1. Verify it.
2. Update documentation.
3. Commit the work.
4. Update progress tracking.
5. Identify the next unfinished task.
6. Continue immediately.

Do not finish a task and then wait.

Do not repeatedly reread the entire repository when you already understand the relevant parts.

Maintain an accurate working understanding of the architecture.

## Rule C: Work in manageable units

Do not attempt massive implementations in one operation.

Break large features into smaller independently testable tasks.

A task should ideally be completable without requiring unrelated changes throughout the application.

## Rule D: No fake completion

Never mark functionality as implemented merely because files were created.

A feature is complete only after its actual behavior has been verified.

Clearly distinguish:
- Implemented.
- Tested.
- Partially implemented.
- Not tested.
- Blocked.

## Rule E: Recover from failures

When a command fails:
1. Inspect the error.
2. Identify the cause.
3. Correct the issue.
4. Retry.
5. Document persistent failures.

Do not repeatedly execute the same failing command without changing anything.

Do not abandon an entire phase because one independent feature is blocked.

---

# 4. PHASE 0 — REPOSITORY DISCOVERY

Start here.

Before changing anything:

1. Inspect the repository root.
2. Read `plans.txt` completely.
3. Inspect all source directories.
4. Inspect Flask routes and blueprints.
5. Inspect authentication.
6. Inspect authorization.
7. Inspect storage implementation.
8. Inspect database schemas.
9. Inspect frontend JavaScript.
10. Inspect shared CSS and components.
11. Inspect dependencies.
12. Inspect configuration.
13. Inspect tests.
14. Inspect deployment configuration.
15. Inspect Git status and existing modifications.

Pay special attention to:

- `app.py`
- `auth.py`
- `storage.py`
- `chat.py`
- `board.py`
- `processing/`
- `pages/`
- `shared/`
- `rules/`
- `data/`

Do not assume the directory structure matches older documentation.

Follow imports and function calls to understand how components interact.

Identify actual entry points and data flows.

## Audit deliverable

Create:

`development/assessment/implementation-assessment.md`

Include:

### Existing and working
Document functionality that already works and should be preserved.

### Existing but improvable
Document incomplete, fragile, inefficient, or poorly integrated functionality.

### Missing
Document functionality required by the roadmap that does not exist.

### Security
Document actual vulnerabilities and weaknesses.

### Data integrity
Document risks involving SQLite, uploads, files, sessions, and persistence.

### Performance
Document actual or potential Raspberry Pi bottlenecks.

### Architecture
Document duplication, coupling, technical debt, and scalability limitations.

### Implementation recommendations
Create a prioritized backlog with dependencies and acceptance criteria.

Every important finding must reference the relevant files and functions.

Do not invent findings.

---

# 5. PHASE 1 — DEVELOPMENT INFRASTRUCTURE

After the assessment, establish a clean implementation environment.

## Git checkpoint

Inspect the current Git state.

Preserve unrelated user modifications.

Create a checkpoint before modifying application code.

Never use destructive Git commands to clean the working tree.

## Development structure

Create a structure similar to:

```text
development/
├── assessment/
│   └── implementation-assessment.md
├── shared/
│   ├── components/
│   ├── utilities/
│   ├── styles/
│   └── documentation/
├── phase-01/
├── phase-02/
├── phase-03/
├── phase-04/
├── phase-05/
├── tests/
├── progress.md
├── architecture.md
└── decisions.md
```

Create one phase directory for every major phase identified in `plans.txt`.

Do not arbitrarily force the roadmap into five phases if it specifies a different structure.

Each phase should contain:
- Implementation files.
- Tests.
- Documentation.
- Integration instructions.
- Any necessary migration scripts.
- A README describing its contents.

Preserve the existing application's directory conventions inside phase folders.

The development directories are staging areas, not disconnected alternative implementations.

Avoid duplicating the entire existing application.

Where changes to existing files are required, provide clear patches or integration instructions.

Shared components should live in the shared development area and be reusable across phases.

## Integration requirement

Completed phase functionality must ultimately be integrated into the actual application.

Do not leave all functionality stranded in development folders.

Keep the application runnable throughout development.

---

# 6. PHASE 2 — MAIN APPLICATION ARCHITECTURE

Before implementing major new features, prepare the main application architecture.

Inspect and modify the necessary main files.

Potential areas:

- Central tool registration.
- Shared frontend utilities.
- Shared components.
- Consistent API conventions.
- Navigation architecture.
- Error handling.
- Authentication integration.
- Storage integration.
- Configuration management.
- Database initialization and migrations.

Only introduce infrastructure justified by the roadmap and audit.

Do not create empty abstractions that have no immediate purpose.

Do not introduce imports for modules that do not exist.

Do not add broken routes.

Do not remove existing routes.

Verify the application starts and existing functionality remains operational after modifications.

---

# 7. PHASE 3 ONWARD — ROADMAP IMPLEMENTATION

Implement every phase from `plans.txt` in its specified order, adjusted only when dependencies or critical security issues require it.

For each phase:

## Step 1: Understand

Inspect the existing code relevant to the phase.

Identify existing functionality and reusable components.

## Step 2: Plan

Create a phase-specific implementation plan.

Break the phase into small tasks.

Identify:
- Dependencies.
- Files affected.
- API changes.
- Database changes.
- Security implications.
- Performance implications.
- Acceptance criteria.

## Step 3: Implement

Implement the tasks.

Prefer focused changes.

Reuse existing architecture.

Keep frontend computation in the browser whenever appropriate.

## Step 4: Test

Test:
- Normal behavior.
- Invalid input.
- Missing data.
- Empty states.
- Large inputs.
- Interrupted operations.
- Permission boundaries.
- Persistence.
- Refresh behavior.
- Mobile behavior where relevant.

Test both frontend and backend where applicable.

## Step 5: Integrate

Move completed implementation files into the correct application locations.

Apply documented patches.

Run regression tests.

Verify all relevant imports, routes, and asset references.

## Step 6: Document

Update:
- Phase README.
- Architecture documentation.
- API documentation.
- Database documentation.
- Main project documentation.
- Progress tracking.

## Step 7: Commit

Create a meaningful Git commit.

Only commit your own verified work.

Then proceed to the next phase.

---

# 8. GLOBAL IMPLEMENTATION STANDARDS

Apply these to every feature.

## User experience

- Consistent design.
- Clear feedback.
- Loading indicators.
- Empty states.
- Error states.
- Confirmation for destructive operations.
- Keyboard accessibility.
- Responsive layouts.
- Reduced-motion support.
- Consistent navigation.
- Sensible defaults.

## Security

- Backend permission enforcement.
- Input validation.
- Safe file handling.
- CSRF protection where applicable.
- Secure session handling.
- No exposed secrets.
- No trust in frontend authorization.
- Safe database queries.
- Protection against path traversal.
- Safe upload handling.

## Reliability

- Handle exceptions.
- Preserve data.
- Use atomic writes where appropriate.
- Use database transactions.
- Avoid corrupting files on interrupted operations.
- Handle reconnects.
- Handle server restarts.
- Clean temporary resources.

## Code quality

- Maintainable functions.
- Consistent naming.
- Limited duplication.
- Sensible modularity.
- Clear API contracts.
- Appropriate comments.
- Tests for critical behavior.

Avoid overengineering.

---

# 9. CONTINUOUS TESTING

Testing must happen throughout development, not just at the end.

Establish a repeatable test procedure.

Where practical:
- Run existing tests before modifications.
- Add tests for new functionality.
- Run affected tests after each task.
- Run the full suite after each phase.
- Run syntax checks.
- Check imports.
- Check route registration.
- Check database migrations.
- Check browser console errors.
- Check application startup.

If the repository lacks tests, establish a lightweight testing framework appropriate for the existing stack.

Do not introduce a heavyweight test infrastructure without justification.

Never claim a browser UI has been visually tested if you only performed syntax checks.

---

# 10. DOCUMENTATION AND PROGRESS TRACKING

Maintain:

`development/progress.md`

Update it continuously.

Use this format:

```markdown
# Development Progress

## Current phase
Phase X

## Completed
- [x] Task

## In progress
- [ ] Task

## Pending
- [ ] Task

## Blocked
- [ ] Task

## Last verified commit
commit hash

## Last test results
Description

## Next action
Specific next task
```

Also maintain:

`development/decisions.md`

Record meaningful architectural decisions and why they were made.

Maintain:

`development/architecture.md`

Keep it synchronized with the actual application.

Documentation must reflect reality.

---

# 11. FAILURE AND BLOCKER HANDLING

If something cannot be completed:

1. Identify the exact blocker.
2. Document the affected functionality.
3. Document what was attempted.
4. Explain why it failed.
5. Determine whether another independent task can proceed.
6. Continue with unblocked work.

Examples of genuine blockers:
- Missing API credentials.
- Unavailable external services.
- Hardware limitations that prevent verification.
- Missing required source files.
- Destructive migration requiring unavailable information.
- A necessary decision that cannot safely be inferred.

Do not treat ordinary coding difficulty as a blocker.

Do not wait for the user when a reasonable alternative exists.

---

# 12. AUTONOMOUS WORK LOOP

After every completed task, execute this loop:

```text
READ CURRENT PROGRESS
        |
        v
IDENTIFY NEXT UNFINISHED TASK
        |
        v
INSPECT RELEVANT IMPLEMENTATION
        |
        v
PLAN THE SMALLEST VALID CHANGE
        |
        v
IMPLEMENT
        |
        v
TEST
        |
        v
REVIEW FOR REGRESSIONS
        |
        v
UPDATE DOCUMENTATION
        |
        v
COMMIT VERIFIED WORK
        |
        v
UPDATE PROGRESS
        |
        v
NEXT TASK
```

Continue until:

1. Every roadmap phase has been implemented and verified.
2. No remaining unblocked tasks exist.
3. Further work would require user intervention.

If the entire roadmap is completed, perform a final application-wide audit.

Do not manufacture unnecessary features to remain busy.

---

# 13. FINAL APPLICATION-WIDE AUDIT

When implementation is complete:

- Run the complete test suite.
- Verify application startup.
- Inspect all registered routes.
- Check authentication and authorization.
- Check database integrity.
- Check file storage integrity.
- Check for missing frontend assets.
- Check for broken imports.
- Check for duplicated implementations.
- Check for unused dependencies.
- Review error handling.
- Review Raspberry Pi performance implications.
- Review documentation consistency.

Produce:

`development/assessment/final-implementation-report.md`

Include:
- Implemented functionality.
- Modified files.
- Added files.
- Database changes.
- Dependencies added.
- Tests executed.
- Test results.
- Known limitations.
- Remaining work.
- Deployment instructions.
- Backup and recovery instructions.

---

# 14. IMPORTANT FINAL INSTRUCTIONS

You are expected to operate as an autonomous engineer, not as a code generator that waits for instructions after every task.

The user has intentionally delegated an extended development session to you.

Use that time productively.

Do not:
- Stop after the initial audit.
- Stop after creating folders.
- Stop after modifying main files.
- Stop after implementing the first feature.
- Stop merely because a phase is large.
- Ask for approval for routine decisions.
- Claim completion without verification.
- Leave integration unfinished.

If you encounter a blocker, work on independent tasks.

If you finish a phase early, proceed to the next phase.

If you finish the entire roadmap, perform additional testing, improve documentation, inspect technical debt, and verify the final result.

Maintain a clean Git history and leave the repository in a working state.

**Your mission is to deliver working software, not merely plans, documentation, or collections of source files.**

Begin with Phase 0 immediately.
