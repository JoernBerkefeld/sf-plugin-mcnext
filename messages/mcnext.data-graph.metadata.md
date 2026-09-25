# summary

Retrieve accessible Data 360 Data Graph metadata.

# description

Performs one read-only `GET /api/v1/dataGraph/metadata` request against an explicit HTTPS Data 360 instance URL. The access-token file must contain only a previously obtained Data 360 bearer token. The command does not perform Salesforce JWT exchange, store credentials, mutate graph definitions, or write evidence into the package.

# flags.instance-url.summary

Tenant-specific HTTPS Data 360 instance URL returned by the token exchange.

# flags.access-token-file.summary

Path to a private file outside the repository containing one Data 360 bearer token.

# examples

- Retrieve accessible Data Graph metadata using an externally obtained token:

  <%= config.bin %> <%= command.id %> --instance-url https://example.c360a.salesforce.com --access-token-file C:\private\data360-token.txt
