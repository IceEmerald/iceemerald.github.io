<div align="center">

<img src="assets/images/icons/favicon.webp" alt="EmeraldNetwork Logo" width="60" />

# Security Policy

</div>

## Supported versions

Only the latest live branch is actively maintained and receives security updates.

| Version | Supported |
|---------|-----------|
| Latest branch / live deployment | ✅ |
| Older commit snapshots | ❌ |

---

## Scope

This policy applies to the EmeraldNetwork repository and the live site hosted under the project domain.

In scope:
- Cross-site scripting (XSS)
- Unsanitized DOM insertion
- Unsafe service worker behavior
- Secret or sensitive data leakage in source or builds

Out of scope:
- Third-party infrastructure or upstream dependencies outside the repository
- General performance issues that are not exploitable
- Non-security bugs unrelated to user safety

---

## Reporting a vulnerability

Please do not open a public GitHub issue for a security bug.

Report it privately through one of these channels:

- GitHub Private Security Advisory: https://github.com/IceEmerald/iceemerald.github.io/security/advisories/new
- Email: hello@emeraldnetwork.groups.id

Include:
1. A clear description of the issue
2. Reproduction steps
3. Impact and affected routes or pages
4. Proposed remediation, if available

---

## Response timeline

| Stage | Target |
|-------|--------|
| Acknowledgement | Within 3 business days |
| Initial assessment | Within 7 business days |
| Fix or mitigation | Best effort, severity-dependent |

---

Thank you for helping keep EmeraldNetwork safe and secure.
