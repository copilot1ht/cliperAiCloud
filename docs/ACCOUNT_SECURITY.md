# Account Security and Access Roles

Cliper AI Cloud stores managed accounts in PostgreSQL. Passwords are hashed with Argon2id and are never returned by an API, written to a browser, or committed to the repository.

## Roles

- `SUPER_ADMIN` / `ADMIN`: full administration access.
- `INVESTOR`: can open monitoring pages and read operational data, but every admin mutation is rejected by the API with HTTP 403.
- `MEMBER` with unlimited entitlement: internal testing account. AI jobs do not debit its wallet, while provider-cost safety caps remain active.
- Normal `MEMBER`: starts without free credits and uses the same top-up and usage billing flow as a new customer.

## Password Administration

The Users & Access page exposes a password-reset action to a full administrator. Password reset:

1. requires a password of at least 10 characters;
2. writes only an Argon2id hash;
3. revokes every active web session for that account;
4. writes an audit-log entry without the password or hash.

An investor cannot call the reset endpoint because all non-read admin requests are blocked before the controller runs.

## Secure One-Time Seed

Do not put account passwords in `.env`, source files, shell scripts, CI logs, or GitHub Actions YAML. Supply a temporary `CLIPER_SEED_ACCOUNTS_JSON` environment variable only for the seed process, run `pnpm accounts:seed`, and remove the variable immediately afterward.

The seed command logs only email, role, plan, and entitlement status. It never logs a password or password hash.

Production should use secret-manager injection for the one-time seed payload and rotate every initial password after the first verified login.
