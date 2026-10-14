# Extract and DPAPI-unwrap the Chromium "Local State" encryption key.
# Writes base64 of the 32-byte AES key to the requested output path.
param(
    [Parameter(Mandatory = $true)][string]$LocalState,
    [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

if (-not (Test-Path $LocalState)) { throw "Local State not found: $LocalState" }
$json = Get-Content -LiteralPath $LocalState -Raw -Encoding UTF8 | ConvertFrom-Json
$encB64 = $json.os_crypt.encrypted_key
if (-not $encB64) { throw "os_crypt.encrypted_key missing in $LocalState" }

$enc = [Convert]::FromBase64String($encB64)
$prefix = [Text.Encoding]::ASCII.GetString($enc, 0, 5)
if ($prefix -ne 'DPAPI') { throw "unexpected key prefix: '$prefix' (expected DPAPI)" }

$blob = [byte[]]::new($enc.Length - 5)
[Array]::Copy($enc, 5, $blob, 0, $blob.Length)

$key = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)

[IO.File]::WriteAllText($Out, [Convert]::ToBase64String($key), [Text.Encoding]::ASCII)
Write-Output ("OK keyLen={0} -> {1}" -f $key.Length, $Out)
