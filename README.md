# dclock
Monica's dclock countdown

## Deployment

Pushes to `main` build and push `$REGISTRY_HOST/dclock:latest`, then trigger Watchtower, using the same workflow as OverlayV1.

Before the first deployment:

- Set the GitHub Actions repository secrets `INFISICAL_DOMAIN` and `INFISICAL_IDENTITY_ID` to the values used by OverlayV1.
- Allow this repository's `main` branch in the Infisical identity's GitHub OIDC trust configuration. The identity needs access to the `prod` environment in the `lords-of-minecraft` project, at `/Registry` and `/Watchtower`.
- Ensure `/Registry` provides `REGISTRY_HOST`, `REGISTRY_USER`, and `REGISTRY_PASSWORD`, and `/Watchtower` provides `WATCHTOWER_URL` and `WATCHTOWER_TOKEN`.
- Configure the server's dclock container to use that image, expose container port `80`, and be included in Watchtower's updates.

GitHub Actions pushes the image before calling Watchtower. The running server must already be configured to pull from the registry; this workflow updates an existing container.
