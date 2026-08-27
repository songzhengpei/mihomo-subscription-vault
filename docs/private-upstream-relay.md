# Optional private upstream relay

The private upstream relay is an advanced fallback for subscriptions that
still return HTTP 403 after the Worker's direct request and optional Browser
Rendering request. It is not required for normal deployments and is not a
complete Docker edition of Mihomo Subscription Vault.

Deploy the relay only on infrastructure you control. Each user must create
their own Cloudflare Tunnel, VPC service, and Worker binding. Never reuse the
maintainer's production infrastructure.

## Architecture

```text
Worker --UPSTREAM_RELAY binding--> Cloudflare VPC service
                                     |
                                     v
                              Cloudflare Tunnel
                                     |
                                     v
                         relay on VPS loopback:8788
```

The relay listens on VPS loopback only and has no public HTTP route. The
Cloudflare Tunnel connector and relay run with Docker Compose.

## Requirements

- A Linux VPS with Docker Engine and Docker Compose
- A domain in your own Cloudflare account
- Cloudflare Tunnel and Workers VPC access in that account
- The Worker already deployed and working without the relay

Cloudflare product availability and commands can change. Check the current
[Workers VPC documentation](https://developers.cloudflare.com/workers-vpc/)
before provisioning resources.

## Prepare the relay

Copy these repository files to a private directory on the VPS:

```text
mihomo-subscription-relay/
├── Dockerfile
├── docker-compose.yml
├── upstream-relay.mjs
└── tunnel-token
```

Sources:

- `deploy/vps-relay/Dockerfile`
- `deploy/vps-relay/docker-compose.yml`
- `scripts/upstream-relay.mjs`

Create a named Cloudflare Tunnel in your own account and save its connector
token as `tunnel-token`. Do not paste the token into Compose, Git, command
history, documentation, or an Issue.

Restrict the token file and start the containers:

```bash
sudo chown root:65532 tunnel-token
sudo chmod 0640 tunnel-token
sudo docker compose config --quiet
sudo docker compose build --pull relay
sudo docker compose up -d
```

## Connect Workers VPC

Create a VPC service in your Cloudflare account that reaches the Tunnel's
private target at `http://127.0.0.1:8788`. Add the resulting service to a
private Wrangler configuration:

```jsonc
{
  "vpc_services": [
    {
      "binding": "UPSTREAM_RELAY",
      "service_id": "<YOUR_VPC_SERVICE_ID>",
      "remote": true,
    },
  ],
}
```

Do not add a real service ID or account-specific route to a public template.
Deploy the Worker again after adding the binding.

## Validate

On the VPS:

```bash
sudo docker compose ps
curl --fail http://127.0.0.1:8788/health
sudo docker compose logs --tail 100
```

Expected results:

- the relay container is healthy;
- the tunnel container is running and connected;
- loopback health returns HTTP 200 with `{"ok":true}`;
- the relay port is not reachable from the public Internet.

Then update one known 403 subscription from the Vault admin page and confirm
the Worker logs report the VPC relay path without logging the full source URL
or subscription token.

## Security boundaries

- Only HTTPS upstream URLs on port 443 are accepted.
- Private, loopback, link-local, multicast, benchmarking, and reserved targets
  are rejected before connection.
- Redirect count, request size, response size, timeout, and User-Agent length
  are bounded.
- The tunnel token stays only on the VPS and must be included in private,
  encrypted backups.
- The relay container uses a read-only filesystem, drops Linux capabilities,
  and runs as a non-root user.

If the relay is unavailable, normal subscriptions still use the Worker's
direct request and optional Browser Rendering paths.
