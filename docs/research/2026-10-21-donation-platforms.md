# Donation platforms (research, 2026-10-21)

For the "Support the project" button on the showcase site (and `.github/FUNDING.yml` once the repo is public). Nothing is set up yet: Jose has no account on any of these.

Fees below come mostly from third-party comparisons; check each platform's own pricing page before signing up.

| | GitHub Sponsors | Ko-fi | Buy Me a Coffee | Liberapay | Open Collective |
|---|---|---|---|---|---|
| Platform fee | **0%** from personal accounts (up to 6% from organization accounts) | 0% on donations; 5% on shop and memberships unless Ko-fi Gold ($12/month) | 5% on everything | 0% (nonprofit, funded by donations) | 0–10% depending on the fiscal host |
| Card processing | Covered by GitHub | Stripe/PayPal fees on top | Stripe/PayPal fees on top | Stripe/PayPal fees on top | Yes |
| One-off donations | Yes | Yes (its strength) | Yes | No: recurring only (weekly, monthly, yearly) | Yes |
| Monthly tiers | Yes | Yes | Yes | Yes | Yes |
| Donor needs an account | A GitHub account | No | No | Yes | No |
| On the repo page | Native "Sponsor" button (public repos) | Link via `FUNDING.yml` | Link via `FUNDING.yml` | Link via `FUNDING.yml` | Link via `FUNDING.yml` |
| Best for | Open-source developers | Creators, casual tips | Creators | Open-source idealists | Teams/projects with shared budgets |
| Colombia | Listed as a supported region | Payouts via PayPal or Stripe; check which works | Check payout options | Check payout options | Depends on the host |

## Recommendation

**GitHub Sponsors + Ko-fi.**

- **GitHub Sponsors**: no fee on personal sponsorships, and the "Sponsor" button sits on the repo itself, which suits an open-source app.
- **Ko-fi**: catches people who want to tip once without a GitHub account; 0% on plain donations.

Both go into one `.github/FUNDING.yml`:

```yaml
github: jorius
ko_fi: <your-ko-fi-name>
```

The showcase site gets one "Support the project" button offering both.

The product spec (P5) also plans a donations link inside the app, opened in the OS browser through the `opener` plugin scoped to that single URL (architecture §6.1). It can point at the showcase site's support section, so the app never needs to change if the platform does.

## Sources

- [About GitHub Sponsors](https://docs.github.com/en/sponsors/getting-started-with-github-sponsors/about-github-sponsors)
- [GitHub Sponsors fees and taxes](https://docs.github.com/en/enterprise-cloud@latest/sponsors/sponsoring-open-source-contributors/about-sponsorships-fees-and-taxes)
- [GitHub Sponsors in 30 new regions (2022)](https://github.blog/2022-07-28-github-sponsors-available-in-30-new-regions-2/)
- [Cheaper Patreon alternatives 2026 (SchoolMaker, a competitor)](https://schoolmaker.com/blog/cheaper-alternatives-to-patreon)
- [Buy Me a Coffee pricing 2026 (SchoolMaker)](https://schoolmaker.com/blog/buy-me-a-coffee-pricing)
