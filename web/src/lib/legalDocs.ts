/**
 * In-app Terms of Use + Privacy Policy (must match LEGAL_DOC_VERSION on server).
 * Product-accurate operator terms for self-hosted MIT distribution — not legal advice.
 */

export const LEGAL_DOC_VERSION = '1'

export const LEGAL_CONTACT_EMAIL = 'daniel@devcon1solutions.com'
export const LEGAL_CONTACT_SITE = 'https://devcon1solutions.com'
export const LEGAL_OPERATOR = 'DevCon1 Solutions'

export type LegalSection = { heading: string; body: string[] }

export const TERMS_OF_USE: LegalSection[] = [
  {
    heading: '1. Agreement',
    body: [
      'By installing, accessing, or using Home Base (“Software”), you (“you”, “Operator”) agree to these Terms of Use and the Privacy Policy. If you do not agree, do not use the Software.',
      'The Software is released under the MIT License by DevCon1 Solutions. These Terms add use conditions and liability limits for public distribution. In a conflict, the MIT license grant still applies to copying and redistribution of the source; these Terms govern your use of an installed instance and any claim against DevCon1 Solutions or contributors.',
    ],
  },
  {
    heading: '2. What Home Base is',
    body: [
      'Home Base is self-hosted control-plane software that can run on your computer and may provide remote access to a shell, files, project actions, screen viewing, optional AI desktop control (Vision), Home Access widgets, VPN (WireGuard), and/or a Cloudflare Tunnel.',
      'DevCon1 Solutions does not operate your instance, host your data, or secure your network. You alone choose where it runs and who can reach it.',
    ],
  },
  {
    heading: '3. Eligibility and responsibility',
    body: [
      'You represent that you are legally allowed to install and operate the Software on the host machine and network you use.',
      'You are solely responsible for: host OS security; passwords, PINs, API keys, and VPN/tunnel credentials; firewall and router settings; who receives share links or WireGuard peer configs; and all actions performed through the Software (including by agents, scripts, or anyone you authorize).',
    ],
  },
  {
    heading: '4. High-risk capabilities — use at your own risk',
    body: [
      'THE SOFTWARE CAN EXECUTE COMMANDS, READ AND WRITE FILES, VIEW OR CONTROL YOUR SCREEN, INVOKE SUDO, AND REACH SERVICES ON YOUR NETWORK. Misconfiguration, weak credentials, exposed ports, stolen sessions, or agent mistakes can cause data loss, system damage, unauthorized access, or other harm.',
      'YOU USE THE SOFTWARE ENTIRELY AT YOUR OWN RISK. Do not expose the Home Base HTTP port directly to the public Internet. Prefer VPN or a properly configured tunnel. You accept that remote control features are inherently dangerous.',
    ],
  },
  {
    heading: '5. No warranty',
    body: [
      'THE SOFTWARE IS PROVIDED “AS IS” AND “AS AVAILABLE”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, SECURITY, OR UNINTERRUPTED OPERATION.',
      'DevCon1 Solutions and contributors do not warrant that the Software will be error-free, secure against all attacks, or suitable for any particular purpose.',
    ],
  },
  {
    heading: '6. Limitation of liability and release',
    body: [
      'TO THE MAXIMUM EXTENT PERMITTED BY LAW, DEVCON1 SOLUTIONS, ITS OWNERS, AFFILIATES, AND CONTRIBUTORS SHALL NOT BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR ANY LOSS OF DATA, PROFITS, GOODWILL, BUSINESS INTERRUPTION, SECURITY BREACH, UNAUTHORIZED ACCESS, OR OTHER LOSS, ARISING OUT OF OR RELATED TO THE SOFTWARE OR THESE TERMS, WHETHER IN CONTRACT, TORT (INCLUDING NEGLIGENCE), STRICT LIABILITY, OR OTHERWISE, EVEN IF ADVISED OF THE POSSIBILITY.',
      'YOU RELEASE AND HOLD HARMLESS DEVCON1 SOLUTIONS AND CONTRIBUTORS FROM ALL CLAIMS ARISING FROM YOUR INSTALLATION, CONFIGURATION, SHARING, OR USE OF THE SOFTWARE.',
      'IF ANY LIABILITY IS NEVERTHELESS IMPOSED, THE TOTAL AGGREGATE LIABILITY SHALL NOT EXCEED THE GREATER OF ZERO U.S. DOLLARS ($0) OR THE AMOUNT YOU PAID DEVCON1 SOLUTIONS (IF ANY) FOR THE SOFTWARE IN THE TWELVE MONTHS BEFORE THE CLAIM. THE SOFTWARE IS TYPICALLY DISTRIBUTED FREE OF CHARGE.',
    ],
  },
  {
    heading: '7. Indemnification',
    body: [
      'You agree to defend, indemnify, and hold harmless DevCon1 Solutions and contributors from any claim, damage, liability, and expense (including reasonable attorneys’ fees) arising from your use of the Software, your content, your network exposure, or your violation of these Terms or applicable law.',
    ],
  },
  {
    heading: '8. Acceptable use',
    body: [
      'You may not use the Software to violate law, harm others’ systems without authorization, distribute malware, or evade security controls you are not allowed to bypass. You may not misrepresent DevCon1 Solutions as the operator or host of your instance.',
    ],
  },
  {
    heading: '9. Third-party services',
    body: [
      'Optional integrations (including Cursor APIs, Cloudflare Tunnel, WireGuard, and public IP geo lookup providers) are governed by those providers’ terms. DevCon1 Solutions is not responsible for third-party outages, policies, or data handling.',
    ],
  },
  {
    heading: '10. Changes',
    body: [
      'Doc version may change when Terms or Privacy Policy are updated. Continued use after a version change may require accepting the new documents in the app. Material updates are reflected in the in-app legal version number.',
    ],
  },
  {
    heading: '11. Contact',
    body: [
      `Questions: ${LEGAL_CONTACT_EMAIL} · ${LEGAL_CONTACT_SITE}`,
      'These Terms do not create a partnership, employment, or consumer support obligation beyond the MIT license and this notice.',
    ],
  },
]

export const PRIVACY_POLICY: LegalSection[] = [
  {
    heading: '1. Who controls data',
    body: [
      'Home Base is self-hosted. The person or organization that installs and runs an instance (“Operator”) controls that instance and the data it stores. DevCon1 Solutions does not receive your chats, files, passwords, or screen content by virtue of you running the Software, unless you independently contact DevCon1 or use a third-party service that does.',
    ],
  },
  {
    heading: '2. Data stored on the host',
    body: [
      'Depending on features you enable, the host may store: password hash and auth metadata; JWT signing material; optional App PIN hash; encrypted secrets (e.g. Cursor API key, Cloudflare tunnel token, sudo session vault) using AES-256-GCM under a local vault key; chat transcripts; daily logs; Home Access widget config; Vision/desktop capture artifacts; WireGuard/Cloudflare state; project registry; notifications; and onboarding/legal acceptance records. Sensitive files are typically written with restrictive permissions (e.g. mode 0600) under the runtime directory.',
      'Browser storage on your clients may hold a session JWT (typically ~24h), UI preferences, and theme settings.',
    ],
  },
  {
    heading: '3. Authentication and sessions',
    body: [
      'Passwords are hashed (scrypt) at rest — not stored in plaintext. Sessions use signed JWTs. Share QR / redeem links issue a short-lived one-time code that becomes a JWT and do not embed your password. Password bootstrap and password change are restricted to localhost browser use where enforced by the Software.',
    ],
  },
  {
    heading: '4. Data that may leave the host',
    body: [
      'Cursor / agent features send prompts, tool context, and related content to Cursor’s services when you use those features — under Cursor’s terms and your API key.',
      'Cloudflare Tunnel (if enabled) routes traffic through Cloudflare according to your tunnel configuration and Cloudflare’s policies.',
      'WireGuard (if enabled) exchanges traffic with peers you configure; private keys stay on devices you control.',
      'For some public client IPs, the Software may query a public geo-IP service (e.g. ip-api.com) to label login/security notifications. Private/VPN/loopback addresses are classified locally without that lookup.',
      'Home Access hooks you configure (HTTP, WebSocket, scripts) may send data to destinations you choose.',
    ],
  },
  {
    heading: '5. What DevCon1 Solutions does not do by default',
    body: [
      'DevCon1 Solutions does not operate a mandatory telemetry cloud for Home Base. There is no built-in sale of personal data to advertisers. Open-source distribution and optional contact with DevCon1 (email/website) are separate from instance data.',
    ],
  },
  {
    heading: '6. Retention and deletion',
    body: [
      'Retention is controlled by the Operator and the host disk. In-app reset/erase and deleting runtime/config files remove local data according to those tools. Uninstalling packages or wiping the machine is the Operator’s responsibility. Revoking third-party keys (Cursor, Cloudflare) must be done with those providers.',
    ],
  },
  {
    heading: '7. Security notice',
    body: [
      'Encryption at rest and transport options reduce risk but do not eliminate it. Compromised hosts, weak passwords, shared QR links, misconfigured tunnels, or Armed Vision control can expose personal and sensitive data. The Operator is responsible for access control and backups.',
    ],
  },
  {
    heading: '8. Children',
    body: [
      'The Software is not directed to children under 13 (or the minimum age in your jurisdiction). Operators should not knowingly allow such use.',
    ],
  },
  {
    heading: '9. Contact',
    body: [
      `Privacy questions about the Software distribution: ${LEGAL_CONTACT_EMAIL}. For data on a specific install, contact that instance’s Operator.`,
    ],
  },
]

export function legalDocPlain(sections: LegalSection[]): string {
  return sections
    .map((s) => `${s.heading}\n\n${s.body.join('\n\n')}`)
    .join('\n\n')
}
