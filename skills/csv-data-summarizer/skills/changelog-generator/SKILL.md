name: changelog-generator
description: Automatically creates user-facing changelogs from git commits by analyzing history and transforming technical commits into customer-friendly release notes.
---

# Changelog Generator

Automatically creates user-facing changelogs from git commits.

## When to Use

- Before creating a release
- When preparing release notes
- When communicating changes to users
- When maintaining a CHANGELOG.md file

## Instructions

1. Fetch recent git commit history (last tag to HEAD, or specified range)
2. Analyze commit messages and categorize changes:
   - Features (feat:)
   - Bug Fixes (fix:)
   - Breaking Changes (BREAKING CHANGE:)
   - Documentation (docs:)
   - Performance (perf:)
   - Refactoring (refactor:)
3. Transform technical commit messages into user-friendly descriptions
4. Group changes by category
5. Highlight breaking changes prominently
6. Generate formatted changelog entry

## Output Format

```markdown
## [Version] - [Date]

### Breaking Changes
- Description of breaking change

### New Features
- User-friendly feature description

### Bug Fixes
- User-friendly fix description

### Improvements
- Performance or UX improvements
