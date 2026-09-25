# sf-plugin-mcnext

Salesforce CLI plugin for working with Marketing Cloud Next data and configuration. The plugin can support read/write workflows overall: it implements MCN-specific capabilities where needed and points to or delegates to the core `sf` CLI when Salesforce CLI already owns retrieval, deployment, or data operations.

CMS-aware migration planning is available through a separately installed, compatible `sf-plugin-cms`. The MCN plugin does not bundle, auto-install, upgrade, downgrade, or repair the CMS provider.

## v1 installation and getting started

### Prerequisites

- Node.js `22.19.0` or later, as required by this package. Verify it with `node --version`.
- Salesforce CLI. Install or update the base CLI with npm, then verify it:

  ```bash
  npm install --global @salesforce/cli
  sf --version
  ```

- A Salesforce org with Marketing Cloud Next/Data 360 features configured for the capability you want to use.
- A user with API access and permission to view or operate on the relevant segment, `MarketSegment`, or identity-resolution resources. Exact licenses, products, and permission sets depend on the org; contact the org administrator if a command returns an authorization or unavailable-resource error.

The v1 commands documented below export or inspect data and configuration, provide one strict Segment Definition CREATE path, and expose Identity Resolution planning without mutation. The capability registry also identifies retrieval and deployment operations owned by the core `sf` CLI. Do not infer mutation support from planning or discovery commands.

### Install the published plugin

```bash
sf plugins install sf-plugin-mcnext
sf plugins
```

The CMS provider is optional for CMS-independent commands. Install it separately only when you intend to use `sf mcnext migration plan --cms-plan`:

```bash
sf plugins install sf-plugin-cms@0.4.0
sf plugins inspect sf-plugin-cms --json
sf cms info --contract-version 1 --json
```

CMS planning requires `sf-plugin-cms` version `0.4.0` or later, but version alone is not sufficient. The provider must be discoverable by the same `sf` executable and advertise compatible command-result and package-manifest contracts, capability `workspace.export.external-reference-correlation`, and correlation contract `sf-cms-external-reference-correlations@1`. A newer provider is accepted only when those retained contracts and semantics remain compatible.

If the provider is missing, too old, newer but incompatible, unavailable, malformed, or missing required provenance/correlation evidence, CMS-dependent planning fails closed. CMS-independent commands and a migration plan without `--cms-plan` remain available.

### Local-development alternative

Use this only when developing or testing a local checkout instead of the published npm package:

```bash
npm install
npm run compile
sf plugins link .
sf plugins
```

### Authorize an org and set an alias

Use the standard Salesforce CLI web login flow. The example sets `my-mcnext-org` as the alias used throughout this guide:

```bash
sf org login web --alias my-mcnext-org --instance-url https://login.salesforce.com
sf org display --target-org my-mcnext-org
```

Use your org's My Domain or the appropriate Salesforce login URL instead of `https://login.salesforce.com` when required. A successful `sf org display` confirms that the CLI can resolve the alias and access the saved authorization. Every v1 command that connects to an org requires `--target-org <alias-or-username>` (or `-o`).

### Set up Data 360 Direct API JWT access for Data Graph metadata

Standard Salesforce org authorization is sufficient for this plugin's Segment, Identity Resolution, and Data Kit discovery paths. Detailed Data Graph metadata is different: `GET /api/v1/dataGraph/metadata` uses the tenant-specific Data 360 API endpoint and requires the Salesforce-to-Data-360 token exchange. Configure it separately in every org.

For `GET /api/v1/dataGraph/metadata`, grant the ECA the least-privilege scopes **Manage user data via APIs (`api`)** and **Perform ANSI SQL queries on Customer Data Platform data (`cdp_query_api`)**. Salesforce metadata represents the latter as `CDPQuery`. This documented setup also retains **Perform requests at any time (`refresh_token`, `offline_access`)**; Salesforce persists that UI selection as `RefreshToken`. It is included for the authorization flow used here, not because the Data Graph metadata endpoint itself requires refresh tokens. Keep **Refresh Token Flow** disabled unless your chosen OAuth flow actually uses it.

Grant only the scopes required by the documented endpoint. Do not add unrelated tooling or agent scopes, substitute profile-oriented scopes, or add broader platform scopes merely to call it; those permissions authorize different or wider capabilities and do not replace the effective `CDPQuery` grant.

An ECA created locally in the consuming org is available there without a separate installation action. A generic error saying that the connected app "should be installed" does not prove that an **Install** button exists or that installation is the remedy; first verify the ECA's saved scopes, JWT configuration, policies, and user assignment.

#### Choose the user model first

- **Interactive developer use:** authenticate as your own named user in each org. This preserves user-level attribution and lets an admin remove one developer without affecting anyone else. Do not share a Salesforce user.
- **Unattended CI or service automation:** use a dedicated integration user with an API-only/minimum-access profile when the org's licenses permit it. Do not use a person's account for an unattended workload.

A single org-local ECA can preauthorize a permission set, and that permission set can be assigned to multiple named users. However, Salesforce's documented JWT setup uploads the certificate to the ECA, and each JWT client supplies the private key associated with that ECA. The documented model does not provide a separate certificate/private-key mapping per preauthorized user. Because that certificate/key relationship is app-level, developers who generate JWTs locally under one ECA would need access to the same signing key. A centrally operated signer could retain one app key, but that is not the developer-operated model documented here. To avoid distributing an app private key, create one local ECA and one key pair **per developer per org**. For CI, create a separate ECA/key pair for the dedicated integration user.

Salesforce's current Data 360 JDBC guidance says an ECA policy selects one permission set or one profile for preauthorization, while the ECA owns the uploaded certificate and the client supplies the matching private key, client ID, and username. Salesforce also says Connected Apps cannot be created after February 21, 2026, so use an ECA for a new setup. See [Getting Started with the Data 360 JDBC Driver](https://developer.salesforce.com/docs/data/data-cloud-query-guide/guide/jdbc-setup.html), [Connect to Salesforce Data 360 Connect API](https://developer.salesforce.com/docs/marketing/marketing-cloud-growth/guide/mc-connect-apis-data-cloud.html), and Trailhead's [External Client App Basics](https://trailhead.salesforce.com/content/learn/modules/external-client-app-basics).

#### Choose the preauthorization marker model

Salesforce evaluates the selected permission set or profile independently for each ECA. The ECA's own Consumer Key/client ID and certificate remain app-specific; selecting the same permission set on several ECAs does not merge their credentials. It does mean that every user assigned that permission set is Salesforce-side preauthorized for **every ECA that selects it**. Possessing the matching private key and client ID is still required to complete this JWT flow, and the user's effective permissions still govern what the resulting session can do.

| Model                                                                            | Least privilege                                                                                                                                                                                                    | Revocation and onboarding                                                                                                                                                                                                               | Fit for this tool                                                                                                                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. One shared marker permission set** selected on every developer-specific ECA | The marker can grant no runtime permissions, but every assignee is eligible for every ECA that selects it. App-specific keys keep credentials separate; the shared marker is not a per-app authorization boundary. | One assignment onboards a developer to the selected ECA set. Removing it revokes that developer's Salesforce-side preauthorization from all of those ECAs at once. Disable an individual ECA or rotate its key to revoke only that app. | **Recommended default.** It is the smallest practical model for an open-source developer tool when the approved developer group is intentionally the same across the org's developer ECAs. |
| **B. One marker permission set per ECA** with a generic app/environment name     | Isolates Salesforce-side eligibility per ECA without using personal names, for example label `sf-plugin-mcnext Data 360 JWT Access - Sandbox` and API name `sf_plugin_mcnext_Data_360_JWT_Access_Sandbox`.         | More assignments and permission sets to maintain, but one user's or app's eligibility can be removed without affecting other ECAs.                                                                                                      | Use only when ECAs have different approved-user populations or policy requires per-app allowlists.                                                                                         |
| **C. Profile preauthorization**                                                  | Every user on the selected profile becomes eligible for the ECA, so the boundary usually includes unrelated users and permissions.                                                                                 | Onboarding or revocation requires profile changes or moving users, coupling app access to broader user administration.                                                                                                                  | Not recommended for developer-specific ECAs. It is generally broader and less flexible than a marker permission set.                                                                       |

For the shared model, create this permission set now:

- **Label:** `sf-plugin-mcnext Data 360 JWT Access`
- **API Name:** `sf_plugin_mcnext_Data_360_JWT_Access` (Salesforce-generated)
- **Description:** `Marker-only allowlist for approved developers using sf-plugin-mcnext Data 360 External Client Apps.`

Keep Salesforce's automatically generated API name when it satisfies the field's validation rules; do not manually normalize it merely to match a different naming style.

Keep it marker-only and assign it only to developers who are intended to be preauthorized for every developer ECA that selects it. If that common-user assumption stops being true, switch the affected ECA to a per-ECA marker permission set using a generic app/environment suffix; do not put a person's name in a permission-set label or API name.

#### Naming the ECA

The **External Client App Name** is a display label and can contain spaces, for example `sf-plugin-mcnext Data 360 - Developer Sandbox`. The separate **API Name** must:

- begin with a letter;
- contain only letters, numbers, and underscores;
- contain no spaces;
- be unique in the org;
- not end with an underscore; and
- not contain consecutive underscores.

A screenshot-verified valid example uses `sfpluginmcnext_Data360_thuy` for both **External Client App Name** and **API Name**. A display name may instead contain spaces, but the API name must still follow the rules above. Examples such as `sf-plugin-mcnext Data 360`, `1_sfpluginmcnext`, `sfpluginmcnext__Data360`, and `sfpluginmcnext_` are invalid API names.

#### Permission and access checklist

Salesforce permission sets add access to the user's existing profile and other assigned permission sets. The permission set selected under an ECA's **App Policies → Select Permission Sets**, the **OAuth Policies → Plugin Policies → Permitted Users** value **Admin approved users are pre-authorized** (`AdminApprovedPreAuthorized`), and assignment of that permission set to the user are sufficient only for app-user preauthorization. They do not grant runtime API, Data 360, data-space, object, or Data Graph access. The recommended shared permission set, label `sf-plugin-mcnext Data 360 JWT Access` and API name `sf_plugin_mcnext_Data_360_JWT_Access`, can therefore be marker-only when those separate effective permissions are already granted by the user's profile or other permission sets. Select it on each developer ECA only when all of its assignees are intended to be preauthorized for that ECA. Do not duplicate broad permissions into it merely to make it selectable.

| Permission/access                                 | Purpose                                                                                                                                                                                                                                              | Required here?                                                                                                                                                                                                                                                               | Where granted                                                                                                                                                                                                                                        | How verified                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API Enabled**                                   | Allows Salesforce API access and the OAuth token exchange.                                                                                                                                                                                           | **Yes, effectively.** It does not have to be in the ECA marker permission set.                                                                                                                                                                                               | The user's profile or any assigned permission set.                                                                                                                                                                                                   | Open the profile and assigned permission sets and confirm **System Permissions → API Enabled**; later, a successful Salesforce JWT token exchange verifies it in use.                                                                                                                                                                                                                                                                                         |
| **Data 360 entitlement / permission-set license** | Makes Data 360 permissions assignable and the product available to the user.                                                                                                                                                                         | **Yes, effectively.**                                                                                                                                                                                                                                                        | The user's license, product entitlement, and, where the org exposes one, the applicable Data 360/Data Cloud permission-set license on the user record.                                                                                               | In **Setup → Users → Users → user**, inspect licenses and permission-set-license assignments; confirm Data 360 opens for that user.                                                                                                                                                                                                                                                                                                                           |
| **Data Cloud Base Permissions**                   | Supplies the base Data 360 access on which functional Data 360 permission sets depend in orgs that expose this permission set.                                                                                                                       | **Do not add again for these audited admin users unless assignment checks show it is missing.**                                                                                                                                                                              | Existing standard Data 360 permission-set assignment or permission-set group. Names vary by org/release.                                                                                                                                             | In the user's **Permission Set Assignments**, confirm the standard Data 360 assignments are present; do not create a custom copy.                                                                                                                                                                                                                                                                                                                             |
| **Data Cloud User**                               | Provides standard Data 360 user capabilities.                                                                                                                                                                                                        | **No new action for these audited admin users.** Add only if absent or a Data 360 token/API call proves a permission gap.                                                                                                                                                    | Standard Salesforce permission set or permission-set group assigned to the user.                                                                                                                                                                     | Check **Permission Set Assignments** and sign in as the user to open Data 360.                                                                                                                                                                                                                                                                                                                                                                                |
| **Data Cloud Architect**                          | Enables Data 360 setup/modeling work such as enabling Data 360, creating connectors, deploying data streams, and configuring identity resolution.                                                                                                    | **No new action for these audited admin users.** It is not required merely to authenticate or read accessible graph metadata. Investigate only after a specific `403` on an operation that needs architect privileges.                                                       | Standard Salesforce permission set or permission-set group assigned to the user.                                                                                                                                                                     | Check **Permission Set Assignments**; verify the specific setup operation, not just token issuance.                                                                                                                                                                                                                                                                                                                                                           |
| **`default` data-space access**                   | Makes objects in the default data space available to the user. Standard Data 360 permission sets apply to the default space.                                                                                                                         | **Yes for a graph in `default`, but normally already inherited from the existing standard assignment.**                                                                                                                                                                      | Standard Data 360 permission set. Non-default spaces require associating an appropriate permission set with that data space.                                                                                                                         | Sign in as the user, select the intended data space, and confirm its objects are visible.                                                                                                                                                                                                                                                                                                                                                                     |
| **Data Graph visibility**                         | Controls which graph metadata `GET /api/v1/dataGraph/metadata` can return; the API returns only accessible graph objects.                                                                                                                            | **Yes for the graph being read.**                                                                                                                                                                                                                                            | Existing Data 360 object/data-space access and graph availability; not the ECA marker permission set.                                                                                                                                                | In Data 360, confirm that the same user can see the required graph in the intended data space. HTTP `200` without that graph points here.                                                                                                                                                                                                                                                                                                                     |
| **ECA preauthorization marker permission set**    | Acts as the ECA's Salesforce-side user allowlist when **Admin approved users are pre-authorized** is selected. A shared marker preauthorizes every assignee for every ECA that selects it; it does not share those ECAs' client IDs or private keys. | **Required for the documented allowlist design.** The marker itself intentionally grants no runtime permissions; successful JWT and Data 360 access still depends on the user's effective permissions and the remaining ECA configuration.                                   | By default, the shared custom permission set `sf_plugin_mcnext_Data_360_JWT_Access`, selected on each developer ECA and assigned only to the common approved-developer group. Use a generic per-ECA marker instead when approved-user groups differ. | Confirm both policy controls: the intended marker is selected under **App Policies → Select Permission Sets**, **OAuth Policies → Plugin Policies → Permitted Users** is set to **Admin approved users are pre-authorized**, and every intended user has the marker assignment. Review all ECAs selecting a shared marker before adding a new assignee. JWT exchange remains the eventual end-to-end verification step; it is not proven by assignment alone. |
| **OAuth scopes**                                  | Authorizes the ECA for the required Salesforce and Data 360 operations. Scopes do not grant permissions the user lacks.                                                                                                                              | **Yes: `api` plus the UI scope `cdp_query_api` (effective metadata value `CDPQuery`).** This setup also retains `refresh_token, offline_access`, which persists as `RefreshToken`, because the documented authorization flow uses it; that grant is not Data Graph-specific. | ECA OAuth settings. Keep **Refresh Token Flow** disabled unless the selected OAuth flow needs it. Do not add unrelated tooling or agent scopes, profile-oriented scopes, or broad platform scopes for this endpoint.                                                                     | Reopen the saved ECA settings and verify `api`, `cdp_query_api`, and the retained `refresh_token, offline_access` selection before testing. If metadata is available, confirm the effective enum includes `CDPQuery` and that the UI refresh grant persisted as `RefreshToken`.                                                                                                                                                                               |

For the already audited admin users, take **no action** to add another **Data Cloud User**, **Data Cloud Architect**, or base-permissions assignment now. Continue with preauthorization and authentication. Revisit those assignments only if a specific request returns `403`, and use the failing endpoint to determine the missing access rather than adding broad permissions speculatively.

#### Configure the already-created ECA

Use these steps when the ECA already exists, such as an app named `<your-data-360-eca>`:

1. In **Setup → External Client App Manager**, open the ECA.
2. Confirm its API name is valid. For example, the UI-verified API name `sfpluginmcnext_Data360_thuy` needs no correction. If the saved API name is different but valid, do not rename it solely to match this example.
3. Open **Settings**, then click **Edit**. Viewing the saved Settings page is not sufficient because an ECA can show OAuth and the `api` scope while its effective `ClientAssertionCertificate` is still null.
4. Under **Flow Enablement**, enable **JWT Bearer Flow** and configure its certificate. JWT Bearer Flow and the certificate are not configured in the separate **Security** section.
5. Under the flow's **Digital Signatures** controls, upload the org-specific public certificate file named `certificate.crt`. Never upload, paste, or otherwise provide `private.key`; the private key remains only with the JWT client.
6. Select **Manage user data via APIs (`api`)** and **Perform ANSI SQL queries on Customer Data Platform data (`cdp_query_api`)**. The effective metadata value for the query scope must be `CDPQuery`. Retain **Perform requests at any time (`refresh_token`, `offline_access`)** for this documented authorization flow; it persists as `RefreshToken`, but it is flow-dependent rather than a Data Graph endpoint requirement. Select only the scopes required by the documented Data Graph endpoint; do not add unrelated tooling or agent scopes, substitute profile-oriented scopes, or add broad platform scopes.
7. Under **Flow Enablement**, leave **Refresh Token Flow** disabled unless the OAuth flow you intentionally selected uses it. The retained `refresh_token, offline_access` UI scope does not by itself require enabling Refresh Token Flow. In **Security**, retain unrelated controls according to org policy:
   - **Require secret for Web Server Flow:** Web Server Flow is not part of this JWT procedure.
   - **Require Proof Key for Code Exchange (PKCE) extension for Supported Authorization Flows:** authorization-code flow is not part of this JWT procedure.
   - **Issue JSON Web Token (JWT)-based access tokens for named users:** leave unchecked; this is separate from enabling JWT Bearer Flow.
8. Click **Save**.
9. Reopen **Settings** before retrieving the Consumer Key or testing. Verify that **JWT Bearer Flow** remains enabled, the public certificate is visibly attached, and `api`, `cdp_query_api`, and the retained `refresh_token, offline_access` selection remain saved. Where effective metadata is shown, verify `CDPQuery` and `RefreshToken`. Keep **Refresh Token Flow** disabled unless the intended OAuth flow needs it. If any setting is missing, return to **Settings → Edit**, correct it, save, and reopen the page to verify persistence.
10. Open **Policies** and click **Edit**.
11. Under **App Policies → Select Permission Sets**, select label `sf-plugin-mcnext Data 360 JWT Access` (API name `sf_plugin_mcnext_Data_360_JWT_Access`). Do not also select a profile; Salesforce documents choosing a profile or permission set, not both. By selecting the shared marker, you intentionally make every current and future assignee Salesforce-side preauthorized for this ECA.
12. Under **OAuth Policies → Plugin Policies → Permitted Users**, select **Admin approved users are pre-authorized** (`AdminApprovedPreAuthorized`). Older Salesforce instructions can say **Manage Policies** or omit **Plugin Policies**; labels vary by release, but use the controls on the ECA's **Policies** page in the order shown here. This setting, the selected marker permission set, and its user assignment establish app-user preauthorization only; runtime API, Data 360, data-space, and Data Graph permissions remain separate.
13. Click **Save**. If a checklist's later step only says to review or return from the policy page after saving, no additional action is required there. The actionable requirement is the selected permission set, the saved **Permitted Users** policy, and the user assignment in the next step.
14. Go to **Setup → Permission Sets → sf-plugin-mcnext Data 360 JWT Access → Manage Assignments → Add Assignments**, select the approved developer, click **Next**, then **Assign** and **Done**. Before adding an assignee, confirm that the person should be preauthorized for every ECA that selects this shared marker. The permission set may remain marker-only.
15. After any saved ECA scope, certificate, flow, policy, or assignment correction, allow several minutes for propagation. Verify the saved configuration again, then make one retry rather than repeatedly submitting the same JWT exchange.

#### Troubleshoot the Salesforce JWT exchange

| Symptom and diagnosis                                                                                                                                                                | Corrective action                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source-org remediation:** the Salesforce JWT exchange returns HTTP `400 invalid_request`, or diagnosis shows a null or missing effective `ClientAssertionCertificate`.             | Open the source ECA's **Settings → Edit**, enable **JWT Bearer Flow**, leave **Refresh Token Flow** disabled unless intentionally used, and re-upload the org-specific public `certificate.crt` under **Digital Signatures**. Confirm `api`, `cdp_query_api`, and the retained `refresh_token, offline_access` selection. Save, reopen **Settings**, and verify the certificate, flow, and scopes persisted. Never upload `private.key`. Allow propagation, then retry once.          |
| **`invalid_scope` during the `/services/a360/token` exchange.**                                                                                                                      | Reopen the ECA and verify the effective OAuth metadata includes `CDPQuery` for the UI scope `cdp_query_api`; `api` alone is insufficient. Do not replace it with unrelated tooling, agent, or profile-oriented scopes, and do not add broad platform scopes merely for this endpoint. Inspect the exchange request and remove any `scope` field. Save any ECA correction, allow propagation, then make one retry.                                                                                                 |
| **Target-org remediation:** the ECA is present locally but the token exchange reports missing authorization, including a generic message that the connected app should be installed. | Do not look for a separate installation action or assume an **Install** button exists. Open the target ECA's **Settings → Edit** and select `api` plus `cdp_query_api`; retain `refresh_token, offline_access` for this documented flow. Save, reopen the settings, and verify the effective values include `CDPQuery` and retained `RefreshToken`. Confirm the JWT certificate/flow and app-user preauthorization separately, wait several minutes for propagation, then retry once. |

#### Reveal and store the Consumer Key / Client ID

For JWT Bearer Flow, the **Consumer Key** is the client ID and becomes the JWT `iss`. The Consumer Secret is not required.

1. In **Setup → External Client App Manager**, open `<your-data-360-eca>`.
2. Open the **Settings** tab.
3. Expand **OAuth Settings**.
4. Under **App Settings**, click **Consumer Key and Secret**.
5. Salesforce opens **Verify Your Identity** and emails a verification code to the masked account shown on that screen. Confirm that the masked address is yours and accessible, enter the code, and click **Verify**. If the address is not yours or you cannot access it, click **Back** and stop; do not ask another person to forward a verification code.
6. After verification, Salesforce opens a Salesforce Classic-style **Consumer Details** page. Confirm that **External Client App Name** identifies `<your-data-360-eca>`. The page shows separate **Consumer Key** and **Consumer Secret** rows, each with its own **Copy** button.
7. Click **Copy** only beside **Consumer Key**. It is the client ID. Never click the **Consumer Secret** Copy button, and never copy, store, share, or screenshot the Consumer Secret.
8. Store the copied Consumer Key immediately using the environment-variable procedure below, then close the Classic **Consumer Details** tab or page.
9. Verify that the copied value is the Consumer Key for `<your-data-360-eca>`, not the app's API name and not a certificate fingerprint. If documentation or support screenshots are necessary, redact the complete Consumer Key and complete Consumer Secret values before capturing or sharing the image.

Salesforce UI labels can vary by release. If the current UI differs, use the equivalent consumer-credential action only after confirming that you are viewing the same ECA; the verified current path is **Settings → OAuth Settings → App Settings → Consumer Key and Secret**.

A Consumer Key is an identifier, not a password. A dedicated plain-text config file containing **only** that key outside every repository is acceptable, but an environment variable is simpler and reduces accidental file pickup. In Windows PowerShell 5.1, replace the placeholder locally and run:

```powershell
[Environment]::SetEnvironmentVariable('SF_MCNEXT_DATA360_CLIENT_ID', '<paste-consumer-key-here>', 'User')
```

Close and reopen the terminal, then verify without printing the value:

```powershell
$clientId = [Environment]::GetEnvironmentVariable('SF_MCNEXT_DATA360_CLIENT_ID', 'User')
if ([string]::IsNullOrWhiteSpace($clientId)) { throw 'Consumer Key is not configured.' }
"Consumer Key configured: $($clientId.Length) characters"
```

If policy requires a file instead, create a user-private directory outside Git repositories, for example `C:\Users\<you>\.sf-plugin-mcnext\`, and a file such as `<your-data-360-eca>-client-id.txt` containing only the Consumer Key and one trailing newline. Do not place the file under this repository, do not add the Consumer Secret, and do not combine it with the private key. The private key belongs in a separate access-controlled key file or approved secret manager.

Use the Consumer Key as JWT `iss`, the developer's own username as `sub`, the matching Salesforce login origin as `aud`, and a short expiration. Exchange the assertion at `/services/oauth2/token`. Then send a form-encoded request to `/services/a360/token` containing exactly `grant_type`, `subject_token`, and `subject_token_type`. Add `dataspace` only when you intentionally target a non-default data space. Do not send a `scope` parameter in this exchange. Use the returned Data 360 `instance_url` for `GET /api/v1/dataGraph/metadata`.

Apply the setup separately to both ECAs: open each ECA, edit **Settings**, select `api` and `cdp_query_api`, retain `refresh_token, offline_access` for this documented flow, confirm JWT Bearer Flow and the correct public certificate, save, reopen, and verify effective `CDPQuery` plus retained `RefreshToken`. Then confirm the intended marker permission set, **Admin approved users are pre-authorized**, and the user's assignment on that ECA. After changes to either ECA, wait several minutes for propagation and perform only one validation attempt: obtain the Salesforce token, submit the scope-free `/services/a360/token` form, and make one bounded metadata GET against the intended data space. If it fails, inspect the response and saved configuration before any further attempt.

Never put a private key, JWT assertion, Salesforce token, Data 360 token, or Consumer Secret in Git, repository-local environment files, chat, tickets, screenshots, or logs. Never copy one developer's ECA/private key to another developer. Removing a user from the shared marker revokes that user's Salesforce-side preauthorization for every ECA selecting it. To revoke only one developer-specific app while preserving the user's access to other ECAs, disable that ECA or rotate its certificate/key pair; use per-ECA marker permission sets instead when independent user-level revocation per app is a requirement.

### First safe commands

Start with the local capability registry; it does not access an org:

```bash
sf mcnext list types
```

Then try a bounded export against an authorized org. Replace the segment value with a segment API name, `MarketSegment` record ID, or exact display name from your org:

```bash
sf mcnext segment members export --target-org my-mcnext-org --segment My_Published_Segment --output-file members.csv --max-items 100
```

The `mcn` topic is a hidden short alias for `mcnext`. This guide uses the full `mcnext` topic. Run `sf <command> --help` when you need the complete generated flag reference.

## v1 command guide

### `sf mcnext list types`

**Purpose:** Show the capability registry: who owns each Marketing Cloud Next capability, its v1 support state, available operations, any core CLI command family, and known limitations.

**Typical uses:** Discover what v1 implements, find capabilities delegated to core Salesforce CLI, or inspect functionality that is conditional or deferred.

**Common flags:**

- `--provider <mcnext|core-sf|cms-service|external/manual|secondary-data>` filters by owner.
- `--state <implemented|delegated|conditional|deferred>` filters by support state.

```bash
sf mcnext list types --provider core-sf
```

**Expected output:** A terminal table titled `Marketing Cloud Next capabilities`, with columns including capability name, provider, state, operations, delegation, and limitation. The command does not require an org.

**Important notes:** A registry row does not mean the plugin implements that capability. `delegated` rows identify work owned by core `sf`; `conditional` and `deferred` rows make the v1 boundary explicit.

### `sf mcnext email send-definition show`

**Purpose:** Read one exact `ListEmail` send-definition record through the installed core Salesforce CLI.

```bash
sf mcnext email send-definition show --target-org my-mcnext-org --record-id 0XB000000000001AAA --api-version 67.0
```

**Boundary:** This is read-only core delegation. It does not create, update, deploy, publish, or send email, and it does not claim portable dependency resolution.

### `sf mcnext email-template show`

**Purpose:** Retrieve one reusable CMS email template by exact managed content ID and verify the `sfdc_cms__emailTemplate` content type.

```bash
sf mcnext email-template show --target-org my-mcnext-org --content-id 20Y000000000001AAA --api-version 67.0
```

**Boundary:** Exact read-only retrieval only. Template creation, update, publication, variants, dependency rewriting, and migration remain unsupported.

### `sf mcnext data-graph metadata`

**Purpose:** Retrieve the Data Graph metadata visible to a previously obtained Data 360 bearer token.

```bash
sf mcnext data-graph metadata --instance-url https://example.c360a.salesforce.com --access-token-file C:\private\data360-token.txt
```

**Boundary:** The command performs one metadata GET. JWT and Data 360 token exchange remain external, the token file must stay outside the repository, and graph creation, update, deployment, and lifecycle actions are not implemented.

### `sf mcnext segment members export`

**Purpose:** Resolve a segment and export its computed members from the verified MCN SSOT members endpoint, writing rows incrementally to CSV or JSON.

**Typical uses:** Produce a bounded membership sample, export a published segment's members for downstream analysis, or request selected SSOT fields with server-side filtering and ordering.

**Required flags:**

- `--target-org` / `-o`: authorized org alias or username.
- `--segment` / `-s`: segment API name, `MarketSegment` record ID, or exact display name.
- `--output-file`: destination path.

**Common flags:** `--result-format <csv|json>` (default `csv`), `--fields`, `--filters`, `--order-by`, `--limit` (page size, default `200`), `--offset`, and the safety bounds `--max-pages`, `--max-items`, and `--max-duration-ms`. CSV output also accepts `--column-delimiter` and `--line-ending`.

```bash
sf mcnext segment members export --target-org my-mcnext-org --segment My_Published_Segment --output-file exports/members.json --result-format json --max-items 1000
```

**Expected output/file:** A streamed CSV file with a header row or a JSON array. The command result reports the resolved `segmentApiName`, output path, format, row count, and completion state.

**Important notes:** This direct endpoint is pinned to API version `67.0`. Pagination defaults are bounded at 1,000 pages, 1,000,000 items, and 15 minutes unless reduced by flags. If a request or safety limit stops the export, the command reports that the partially written file is incomplete. Member `id` values are opaque Watson/SSOT membership values, not asserted Salesforce CRM record IDs.

### `sf mcnext segment records export`

**Purpose:** Export Salesforce `MarketSegment` records and their status fields through the core Salesforce CLI bulk data export command.

**Typical uses:** Inventory segment records, compare segment and publish statuses, or create a CSV/JSON record extract separate from computed segment membership.

**Required flags:**

- `--target-org` / `-o`: authorized org alias or username.
- `--output-file`: destination path.

**Common flags:** `--result-format <csv|json>` (default `csv`), `--wait` / `-w` in minutes (default `10`), `--all-rows`, `--api-version`, and CSV `--column-delimiter` / `--line-ending` settings.

```bash
sf mcnext segment records export --target-org my-mcnext-org --output-file exports/segments.csv
```

**Expected output/file:** The command first prints the equivalent `sf data export bulk` invocation. Core Salesforce CLI then owns job progress, errors, result details, and creation of the requested CSV or JSON file. The export queries `Id`, `Name`, `MarketSegmentType`, `SegmentStatus`, and `PublishStatus` from `MarketSegment`.

**Important notes:** This is deliberate core `sf` delegation rather than a second bulk-export implementation. It exports segment records, not the computed member rows handled by `segment members export`. Availability and permissions therefore follow the installed core bulk data command and the org's access to `MarketSegment`.

### `sf mcnext identity-resolution list`

**Purpose:** List identity-resolution ruleset configurations and their aggregate statuses from the verified MCN endpoint.

**Typical uses:** Find a ruleset ID for `show` or `export`, review ruleset/job status, or compare aggregate unified-profile counts across configurations.

**Required flags:** `--target-org` / `-o` for the authorized org. `--api-version` is available but v1 accepts only `67.0`.

```bash
sf mcnext identity-resolution list --target-org my-mcnext-org
```

**Expected output:** A terminal table titled `Identity-resolution configurations`, including ruleset ID, label, data space, ruleset status, last job status, and total unified profiles.

**Important notes:** The endpoint has no proven pagination contract, so v1 performs one collection request. The result is configuration and aggregate status data; it is not an export or migration of unified-profile rows.

### `sf mcnext identity-resolution show`

**Purpose:** Return one complete identity-resolution ruleset configuration by Salesforce ruleset ID.

**Typical uses:** Inspect filters, matching and reconciliation rules, referenced objects, statuses, and aggregate counts before exporting or troubleshooting a configuration.

**Required flags:**

- `--target-org` / `-o`: authorized org alias or username.
- `--ruleset-id`: Salesforce identity-resolution ruleset ID, usually obtained from `identity-resolution list`.

`--api-version` is available but v1 accepts only `67.0`.

```bash
sf mcnext identity-resolution show --target-org my-mcnext-org --ruleset-id 1ir000000000001AAA
```

**Expected output:** The bare ruleset configuration object is returned to the CLI. Add the global `--json` flag when machine-readable terminal output is preferred.

**Important notes:** This command reads configuration and aggregate status only. It does not return computed unified-profile rows or perform migration.

### `sf mcnext identity-resolution export`

**Purpose:** Write one complete identity-resolution ruleset configuration to a formatted JSON file.

**Typical uses:** Keep a configuration snapshot, review or compare rules outside the org, or prepare configuration evidence for a future migration workflow.

**Required flags:**

- `--target-org` / `-o`: authorized org alias or username.
- `--ruleset-id`: Salesforce identity-resolution ruleset ID.
- `--output-file`: destination JSON path.

`--api-version` is available but v1 accepts only `67.0`.

```bash
sf mcnext identity-resolution export --target-org my-mcnext-org --ruleset-id 1ir000000000001AAA --output-file exports/identity-resolution.json
```

**Expected output/file:** A UTF-8, indented JSON file containing the bare configuration object. Missing parent directories are created. The command result identifies the ruleset and output path.

**Important notes:** This is a configuration export, including available filters, match rules, reconciliation rules, statuses, counts, and referenced DMO names. It does not migrate unified profiles or export their computed rows.

### `sf mcnext segment definition create`

**Purpose:** Strictly create one mapped `MarketSegmentDefinition` through Core Salesforce CLI, with mandatory check-only validation, create-only conflict checks, independent metadata readback, and bounded read-only Connect correlation.

**Required inputs:** Provide distinct `--source-org` and `--target-org` aliases, both expected 18-character org IDs, an existing `--project-dir`, the exact `--source-file` under a configured package directory, its exact `--member` API name, and a `--mapping-file`. The mapping file must explicitly cover the supported source references; mapping is never inferred from matching names. `--wait` is bounded to 1–30 minutes and `--visibility-polls` to 1–10.

```bash
sf mcnext segment definition create --source-org source-mcn --target-org target-mcn --expected-source-org-id 00D000000000001AAA --expected-target-org-id 00D000000000002AAA --project-dir ./project --source-file force-app/main/default/marketSegmentDefinitions/FreshSegment.marketSegmentDefinition-meta.xml --member FreshSegment --mapping-file mappings/segment.json --dry-run
```

**Dry-run and CREATE behavior:** `--dry-run` performs Core check-only deployment and returns `validated` without applying. Without it, the command re-verifies both org identities and target absence immediately before Core apply. Source and target must be different orgs. Existing or ambiguous target identity fails; there is no UPDATE, upsert, overwrite, unchanged-result acceptance, or automatic write retry.

**Readback and pending safety:** After apply, the command retrieves the exact selected member into a fresh empty DX project and compares its supported semantics with the mapped source. It then performs bounded GET-only Connect checks to correlate the API name, definition ID, segment ID, type, and non-published lifecycle. If Core apply and independent readback succeed but Connect visibility has not converged within the bounded polls, the result is `pending` and the command exits with code `69`. A pending result must be investigated; never blindly rerun CREATE because the target may already exist. The command never publishes, schedules, calculates membership, activates, or runs the segment.

### `sf mcnext identity-resolution plan`

**Purpose:** Produce a conflict-checked CREATE plan or exact UPDATE shell for Identity Resolution configuration while remaining strictly mutation-free.

**Contract:** The input file contains only `configuration` and explicit family-local `mappings`. The command separately verifies source and target org IDs, applies only declared mappings, and uses target GET requests to detect exact label/object-key conflicts or to compare an exact ruleset ID, label, key, and status. `create` rejects an existing exact target. `update-shell` requires all four expected target fields and returns semantic differences against the retrieved configuration.

```bash
sf mcnext identity-resolution plan --intent create --source-org source-mcn --target-org target-mcn --expected-source-org-id 00D000000000001AAA --expected-target-org-id 00D000000000002AAA --input-file identity-resolution-plan.json --api-version 67.0
```

**Checkpoint limitations:** This is planning only, not Identity Resolution CREATE or UPDATE. The result explicitly permits only `GET` and blocks `POST`, `PATCH`, publication, scheduling, and run-now paths. It never emits a prospective request body. The CREATE writable schema, PATCH writable schema, and mutation-free lifecycle behavior remain blocked because authoritative contracts are not established in this repository. A successful plan therefore does not authorize mutation or claim Identity Resolution migration support.

### `sf mcnext flow source`

**Purpose:** Retrieve selected Flow source, validate it through Core check-only deployment, or explicitly create/update one inactive same-org draft. Core Salesforce CLI remains the metadata transport; this adapter adds bounded selection and identity checks.

**Key inputs:**

- Every operation requires `--operation <retrieve|validate|create|update>`, `--member <exact-Flow-API-name>`, `--target-org <alias-or-username>`, and `--project-dir <existing-DX-project>`. `--wait` accepts 1–30 minutes (default `10`). Use `--json` for structured results.
- `retrieve` and `validate` accept repeated `--member` selections and use the project's configured package directories. Validation does not apply a deployment.
- `create` and `update` require exactly one member plus `--source-file <Flow-XML-path>`, `--expected-org-id <18-character-destination-org-ID>`, `--source-org-id <18-character-source-org-ID>`, and `--reuse-same-org-references`. The source file must be inside a configured package directory. Source and destination org IDs must match: source provenance and reference reuse are explicit caller-verified declarations, not inferred mappings.
- `update` additionally requires `--expected-definition-id <18-character-FlowDefinition-ID>` and `--expected-latest-version-id <18-character-latest-Flow-version-ID>` from a verified current target baseline. A normal UPDATE must differ semantically in the top-level `label` and/or `interviewLabel`, match all other baseline semantics, and return exactly the selected member as `Changed`. For an exact unchanged repeat, add `--expect-unchanged`; Core must instead report exactly the selected member as `Unchanged`. Every terminal successful apply is followed by an independent Core retrieval whose Flow XML must remain semantically equal to the submitted source and whose definition must remain inactive. These flags are UPDATE-only.

**Mutation contract:** CREATE requires a fresh valid API name and rejects an existing definition rather than overwriting it. UPDATE requires the existing inactive member, checks its identity, status and modification baseline before and after dry-run, and never falls back to CREATE. Supported source is inactive `Draft` or `InvalidDraft` `AutoLaunchedFlow` XML. Configuration is transported unchanged, including actions, inputs, tracking, wiring and `publishSegment`; it is not stripped into a simplified replacement or made runtime-ready.

**Results and caller coordination:** Results identify the operation, state, Core job and retained member diagnostics. A pending result is not success (public command exit code `69`): inspect the Core job before retrying. Core provides neither atomic create-only deployment nor atomic update-only/compare-and-swap. Reserve the selected name or existing target against concurrent external writers for the entire operation; preflight and post-dry-run checks do not close the final check/apply race. No activation, execution, debugging, sending, publication operation, or Campaign-association rewrite is exposed.

**Retained acceptance (2026-09-15):** A normally packed, freshly privately npm-installed candidate passed public oclif retrieve, real check-only validation, same-org draft CREATE, UPDATE and repeat UPDATE. Independent XML readbacks matched the intended documents; repeated CREATE rejected the existing name, and the original source remained unchanged. Follow-up reads confirmed inactive definitions and versions, no active/activation/scheduled-start values on the selected FlowRecords, and no Campaign association on the two new fixtures. Repetition proves semantic equality, not absence of platform timestamp changes or automation side effects. This is public installed-command evidence, not host `sf plugins install` registration, cross-org Flow portability, runtime readiness, or historical no-send proof.

### `sf mcnext campaign config`

**Purpose:** Export, create or update a bounded Campaign scalar configuration through Core Salesforce CLI. Supported fields are `Name`, `Type`, `Status`, `IsActive` and `Description`; this is not a Campaign dependency-tree migration.

**Key inputs:**

- Every operation requires `--operation <export|create|update>`, `--target-org <alias-or-username>`, `--expected-org-id <18-character-org-ID>`, `--api-version <version>`, and `--project-dir <existing-directory>`. Relative file paths resolve from that directory; `--json` returns the structured result.
- `export`: exact `--record-id <18-character-Campaign-ID>` and `--output-file <new-artifact-path>`.
- `create`: `--input-file <artifact-path>`, a distinct fresh `--target-name`, and `--journal-file <new-private-journal-path>`.
- `update`: `--input-file <patch-path>`, exact `--record-id <18-character-target-Campaign-ID>`, and `--expected-name <current-target-name>`. UPDATE cannot rename or upsert.

**Artifacts and safety:** Input artifacts contain `sourceId` and a nonempty `fields` object. Export omits null scalar values. CREATE explicitly records the source-to-target identity mapping in its journal, retaining target-local owner defaults. A private pending journal is written before mutation and the returned identity is saved before readback. Existing target names are rejected, but name absence checks are not atomic uniqueness guarantees. UPDATE verifies the exact ID/current name, checks submitted values by readback, and preserves the selected untouched fields and relationships. For the repeated unchanged acceptance pass, add `--expect-unchanged` so the independently retrieved baseline must already equal every submitted scalar before the write is repeated. Source relationships are rejected on export; relationship inputs, custom fields, null clearing, empty strings and complex quoting are unsupported. Reconcile failed or ambiguous writes manually; never blindly retry. Repeated UPDATE can rerun automation even when scalar values are unchanged. No member migration, sending, schema deployment or automatic lifecycle operation is implemented.

**Retained acceptance (2026-09-15):** An independently packed and privately npm-installed candidate passed public-command cross-org export, five-scalar CREATE, exact readback, Description UPDATE and repeat UPDATE, including preservation checks and an existing-name CREATE conflict. The source remained unchanged. Campaign-specific compiled implementation and messages, the Campaign manifest entry, and the shared Core execution function match the newer normally packed Flow candidate. The full shared Flow module and package metadata differ: this is matching component provenance, not a new Campaign roundtrip on that newer package or proof of an identical complete dependency tree. Scalar repeat equality does not prove side-effect idempotence or absence of indirect/background sends.

**Combined evidence boundary:** These bounded Flow/Campaign checks do not establish host `sf` plugin registration, integration with the current CMS provider, cross-org Flow rewriting, Flow-to-Campaign association creation, or complete seven-family migration acceptance.

### `sf mcnext migration plan`

**Purpose:** Write a deterministic source-to-target assessment. The command performs bounded prerequisite checks and can optionally add CMS contract, package, correlation, and workspace-route evidence. It is always planning-only.

**Typical use:** Compare source and target prerequisites, retain a stable capability inventory, or assess CMS workspace evidence and explicit source-to-target routes before deciding what can be migrated manually or by another tool.

**Key inputs:**

- `--source-org <alias-or-username>`: source org used for read-only assessment and CMS export.
- `--target-org <alias-or-username>` / `-o`: target org used for read-only prerequisite checks.
- `--output-file <path>`: destination for the deterministic JSON plan.
- `--cms-plan`: enables CMS provider discovery and one read-only aggregate export of Marketing workspaces.
- `--cms-workspace-map <path>`: required with `--cms-plan`; supplies explicit source-workspace-ID to target-workspace-ID routes.
- `--cms-export-dir <path>`: required with `--cms-plan`; must identify a new, unused run-owned location for exported packages and retained evidence.
- `--cms-evidence-file <path>`: optional separately supplied opaque evidence; it does not invoke CMS or make a plan executable.

The three CMS planning flags are a unit: both companion flags are required when `--cms-plan` is present, and neither companion flag is accepted without it. The workspace-map file has exactly this shape:

```json
{
  "version": 1,
  "workspaces": {
    "0Zu000000000001AAA": "0Zu000000000101AAA",
    "0Zu000000000002AAA": "0Zu000000000102AAA"
  }
}
```

Keys are exact canonical source workspace IDs and values are explicit target workspace IDs. Workspace names are never routing keys. The parser rejects duplicate JSON keys, duplicate target routes, empty or whitespace-altered IDs, unsupported versions, unexpected fields, empty maps, and oversized input. The plan retains the map's exact-byte SHA-256 and byte length as provenance. A missing route blocks only the affected CMS workspace.

Create a CMS-independent assessment:

```bash
sf mcnext migration plan --source-org source-mcn --target-org target-mcn --output-file migration-plan.json
```

Add CMS planning evidence:

```bash
sf mcnext migration plan --source-org source-mcn --target-org target-mcn --output-file migration-plan.json --cms-plan --cms-workspace-map cms-workspaces.json --cms-export-dir .mcnext-runs/cms-export
```

Supply opaque evidence without invoking CMS:

```bash
sf mcnext migration plan --source-org source-mcn --target-org target-mcn --output-file migration-plan.json --cms-evidence-file cms-evidence.json
```

**Output and artifacts:** The command prints a `Migration prerequisite preflight` table and writes the JSON plan. Without CMS planning, a representative `--json` result is:

```json
{
  "outputFile": "migration-plan.json",
  "sourceOrgId": "0ZZ000000000001AAA",
  "targetOrgId": "0ZZ000000000002AAA",
  "preflightPassed": true,
  "inventoryItems": 66,
  "deferredCmsDependencies": 0,
  "readOnly": true
}
```

When CMS planning is requested, the result adds a bounded summary of the CMS branch:

```json
{
  "outputFile": "migration-plan.json",
  "sourceOrgId": "0ZZ000000000001AAA",
  "targetOrgId": "0ZZ000000000002AAA",
  "preflightPassed": true,
  "inventoryItems": 66,
  "deferredCmsDependencies": 0,
  "cmsPlanning": { "state": "ownership-uncertain", "experimental": true, "readyRoutes": 0, "blockedRoutes": 1 },
  "readOnly": true
}
```

The plan file begins with stable top-level fields and contains detailed `preflight`, `inventory`, optional `cmsPlanning`, and deferred-evidence records:

```json
{
  "schemaVersion": 1,
  "mode": "read-only",
  "testedApiVersion": "67.0",
  "sourceOrgId": "0ZZ000000000001AAA",
  "targetOrgId": "0ZZ000000000002AAA",
  "executableTargetPayloads": []
}
```

**CMS provider operations:** Planning invokes only these public CLI surfaces:

```bash
sf cms info --contract-version 1 --json
sf cms export workspace --target-org <source-org> --all --workspace-type Marketing --output-dir <cms-export-dir> --contract-version 1 --json
```

The export runs once per planning request. MCN validates the provider identity and version, status/exit agreement, capability state, package manifest, exact-byte hashes, path confinement, source-org/workspace/package provenance, and `sf-cms-external-reference-correlations@1` evidence. Correlation uses exact opaque source-value equality only. MCN does not inspect item bodies to derive identity, normalize or hash source references, fuzzy-match names or IDs, synthesize mappings, discover CMS dependencies, choose import order, or perform CMS-internal rewriting. CMS remains the owner of identity, dependency closure, canonical `referenceId` values, package schemas, source-to-target CMS mappings, import ordering, and internal rewrites.

**Planning states:**

- `ready-for-execution`: not produced because the command has no independently evidenced MCN dependency source.
- `partial`: usable evidence exists, but one or more CMS-dependent branches are blocked or failed.
- `blocked`: compatibility, capability, route, integrity, provenance, or correlation evidence prevents execution readiness.
- `failed`: CMS discovery or export failed.
- `ownership-uncertain`: exact ownership or field semantics are not evidenced.
- `experimental`: a visible qualifier on otherwise ready or partial evidence, not a primary state and not a waiver for validation.

Capabilities advertised as `implemented` or `experimental` can contribute planning evidence when every required check passes. Experimental qualification is visible in human output, command results, and plan records. Human output also summarizes CMS state and route counts separately from prerequisite preflight, with guidance when CMS planning is not ready. Correlations are retained as planning evidence, but there is no independently evidenced workspace/owner/field-bound MCN dependency source, so successful package and route evidence remains `ownership-uncertain` and produces no ready dependent edge. `--cms-evidence-file` input cannot fill that gap. Missing or unknown capability states, `unavailable` capabilities, malformed envelopes, incompatible contracts, partial package evidence, unresolved provider diagnostics, package/provenance failures, and zero, duplicate, or conflicting exact correlations block the dependent branch.

**Important limitations:** The command may read org prerequisites, discover the CMS provider, run read-only aggregate export, read public package evidence, and write local plan/evidence files. It never runs CMS import, passes `--apply`, deploys, writes or deletes target records, rewrites references, creates executable target payloads, performs cleanup or rollback, or mutates either org. Without `--cms-plan`, no CMS command runs, and CMS provider failures do not affect CMS-independent paths.

## Capability ownership

`sf mcnext list types` uses these support states:

- `implemented` — this plugin provides the listed operations.
- `delegated` — use the core `sf` CLI command shown in the `delegatedTo` column.
- `conditional` — evidence exists, but v1 does not expose the capability because safe portable behavior is not established.
- `deferred` — intentionally outside this plugin's v1 scope.

Flows, flow definitions, flow tests, managed content types, content type bundles, and segment records remain delegated to core Salesforce CLI functionality. Segment Definition CREATE is implemented as a strict MCNext safety adapter over Core validation, apply, and independent retrieval; it does not add UPDATE or lifecycle operations. Identity Resolution planning is implemented but GET-only and does not claim mutation. Some delegated metadata capabilities support both retrieval and deployment, which is why the plugin should be understood as part of broader read/write MCN workflows.

## v1 scope and limitations

- Direct Marketing Cloud Next API commands are pinned to API version `67.0`. Other versions are rejected because the retained endpoints were verified only against v67.
- CMS-aware migration planning requires the separately installed provider and consumes only its public CLI JSON contract. There is no direct CMS JavaScript API dependency.
- `sf mcnext migration plan` is assessment-only and writes no executable target payloads.
- `ListEmail` has an exact read-only public command delegated to core `sf`; portable dependency resolution, safe deployment, publication, and sending have not been proven.
- Email Templates support exact read-only Connect API retrieval only; creation, update, publication, variants, and migration remain unsupported.
- Data Graph support retrieves accessible metadata using an externally obtained Data 360 token; token exchange and graph mutation remain outside the command.
- Identity-resolution list/show/export support is configuration-only. The planning command remains GET-only with blocked CREATE, PATCH, and lifecycle checkpoints; no Identity Resolution mutation is implemented.
- Segment Definition support is strict CREATE only. Mapping, dry-run validation, independent readback, and pending visibility safeguards do not imply UPDATE, publication, scheduling, or membership execution.
- Segment member export is read-only. Member IDs are opaque SSOT membership values and are not asserted to be Salesforce CRM record IDs.
- v2/v3 documentation must add migration and CMS prerequisites when those capabilities become available; the v1 prerequisites are not sufficient for those future workflows.

## Authorized NUT

The live NUT is read-only and takes its authorized org alias, expected org ID, and published segment API name from private environment variables. It writes a bounded JSON export to a temporary directory, checks only sanitized structure and counts, and then removes the temporary files. The test fails closed before execution if any required value is missing or malformed.

Authorize the intended org alias before opting in:

```bash
sf org login web --alias <authorized-org-alias> --instance-url https://login.salesforce.com
sf org display --target-org <authorized-org-alias> --json
```

Confirm the displayed org identity and choose an existing published segment. Then set the private inputs and opt in:

```bash
SF_PLUGIN_MCNEXT_NUT_ORG_ALIAS=<authorized-org-alias> \
SF_PLUGIN_MCNEXT_NUT_ORG_ID=<expected-18-character-org-id> \
SF_PLUGIN_MCNEXT_NUT_SEGMENT_API_NAME=<published-segment-api-name> \
SF_PLUGIN_MCNEXT_NUTS=1 npm run test:nuts
```

In PowerShell 5.1:

```powershell
$env:SF_PLUGIN_MCNEXT_NUT_ORG_ALIAS = '<authorized-org-alias>'
$env:SF_PLUGIN_MCNEXT_NUT_ORG_ID = '<expected-18-character-org-id>'
$env:SF_PLUGIN_MCNEXT_NUT_SEGMENT_API_NAME = '<published-segment-api-name>'
$env:SF_PLUGIN_MCNEXT_NUTS = '1'
npm run test:nuts
```

Without the opt-in variable, the live NUT is skipped. Do not commit private NUT values or add defaults for them.

## License

MIT
