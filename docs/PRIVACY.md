# Privacy Policy — Home Base

**Version:** 1  
**Distributor:** DevCon1 Solutions  
**Contact:** daniel@devcon1solutions.com · https://devcon1solutions.com

This file mirrors the in-app Privacy Policy. The app requires acceptance of the current version before you can continue.

---

## 1. Who controls data

Home Base is self-hosted. The person or organization that installs and runs an instance (“Operator”) controls that instance and the data it stores. DevCon1 Solutions does not receive your chats, files, passwords, or screen content by virtue of you running the Software, unless you independently contact DevCon1 or use a third-party service that does.

## 2. Data stored on the host

Depending on features you enable, the host may store: password hash and auth metadata; JWT signing material; optional App PIN hash; encrypted secrets (e.g. Cursor API key, Cloudflare tunnel token, sudo session vault) using AES-256-GCM under a local vault key; chat transcripts; daily logs; Home Access widget config; Vision/desktop capture artifacts; WireGuard/Cloudflare state; project registry; notifications; and onboarding/legal acceptance records. Sensitive files are typically written with restrictive permissions (e.g. mode 0600) under the runtime directory.

Browser storage on your clients may hold a session JWT (typically ~24h), UI preferences, and theme settings.

## 3. Authentication and sessions

Passwords are hashed (scrypt) at rest — not stored in plaintext. Sessions use signed JWTs. Share QR / redeem links issue a short-lived one-time code that becomes a JWT and do not embed your password. Password bootstrap and password change are restricted to localhost browser use where enforced by the Software.

## 4. Data that may leave the host

- **Cursor / agent features** send prompts, tool context, and related content to Cursor’s services when you use those features — under Cursor’s terms and your API key.
- **Cloudflare Tunnel** (if enabled) routes traffic through Cloudflare according to your tunnel configuration and Cloudflare’s policies.
- **WireGuard** (if enabled) exchanges traffic with peers you configure; private keys stay on devices you control.
- For some **public client IPs**, the Software may query a public geo-IP service (e.g. ip-api.com) to label login/security notifications. Private/VPN/loopback addresses are classified locally without that lookup.
- **Home Access hooks** you configure (HTTP, WebSocket, scripts) may send data to destinations you choose.

## 5. What DevCon1 Solutions does not do by default

DevCon1 Solutions does not operate a mandatory telemetry cloud for Home Base. There is no built-in sale of personal data to advertisers. Open-source distribution and optional contact with DevCon1 (email/website) are separate from instance data.

## 6. Retention and deletion

Retention is controlled by the Operator and the host disk. In-app reset/erase and deleting runtime/config files remove local data according to those tools. Uninstalling packages or wiping the machine is the Operator’s responsibility. Revoking third-party keys (Cursor, Cloudflare) must be done with those providers.

## 7. Security notice

Encryption at rest and transport options reduce risk but do not eliminate it. Compromised hosts, weak passwords, shared QR links, misconfigured tunnels, or Armed Vision control can expose personal and sensitive data. The Operator is responsible for access control and backups.

## 8. Children

The Software is not directed to children under 13 (or the minimum age in your jurisdiction). Operators should not knowingly allow such use.

## 9. Contact

Privacy questions about the Software distribution: daniel@devcon1solutions.com. For data on a specific install, contact that instance’s Operator.
