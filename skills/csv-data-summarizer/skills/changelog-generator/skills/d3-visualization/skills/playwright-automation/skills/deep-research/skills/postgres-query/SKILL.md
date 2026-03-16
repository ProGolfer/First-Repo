name: postgres-query
description: Execute safe read-only SQL queries against PostgreSQL databases with multi-connection support and defense-in-depth security.
---

# PostgreSQL Query

Executes safe read-only SQL queries against PostgreSQL databases.

## When to Use

- When analyzing database data
- When generating reports from PostgreSQL
- When investigating data issues
- When exploring database schema

## Instructions

1. Verify connection is read-only (no INSERT/UPDATE/DELETE)
2. Connect to PostgreSQL database
3. Execute safe SELECT queries only
4. Format results clearly
5. Handle errors gracefully

## Security Rules

- NEVER execute DML statements (INSERT, UPDATE, DELETE)
- NEVER execute DDL statements (CREATE, DROP, ALTER)
- Use parameterized queries when possible
- Respect connection limits
- Close connections promptly

## Output Format

- Query executed
- Row count
- Results (formatted table or JSON)
- Execution time
