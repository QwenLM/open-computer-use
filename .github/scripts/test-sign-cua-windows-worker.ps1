# Copyright 2026 Qwen Team
# SPDX-License-Identifier: Apache-2.0

# Test-signs the UIAccess worker through the SignPath REST API so a dry run can
# exercise the signed install path. The test certificate is trusted only on the
# disposable hosted runner; release builds do not run this script.

param(
  [Parameter(Mandatory = $true)][string]$Worker
)

$ErrorActionPreference = 'Stop'
$required = @(
  'SIGNPATH_API_TOKEN', 'SIGNPATH_ORGANIZATION_ID', 'SIGNPATH_PROJECT_SLUG',
  'SIGNPATH_SIGNING_POLICY_SLUG', 'SIGNPATH_ARTIFACT_CONFIGURATION_SLUG',
  'SIGNPATH_TEST_CERT_THUMBPRINT'
)
foreach ($name in $required) {
  if (-not [Environment]::GetEnvironmentVariable($name)) {
    throw "$name is not configured for this repository"
  }
}
$organization = [guid]::Parse($env:SIGNPATH_ORGANIZATION_ID)
$expectedThumbprint = $env:SIGNPATH_TEST_CERT_THUMBPRINT.ToUpperInvariant()
if ($expectedThumbprint -notmatch '^[0-9A-F]{40}$') {
  throw 'SIGNPATH_TEST_CERT_THUMBPRINT must be a SHA-1 certificate thumbprint'
}
$api = "https://app.signpath.io/Api/v1/$organization"
$headers = @{ Authorization = "Bearer $env:SIGNPATH_API_TOKEN" }
$submitted = Invoke-WebRequest -Method Post -Uri "$api/SigningRequests/SubmitWithArtifact" -Headers $headers -Form @{
  projectSlug               = $env:SIGNPATH_PROJECT_SLUG
  signingPolicySlug         = $env:SIGNPATH_SIGNING_POLICY_SLUG
  artifactConfigurationSlug = $env:SIGNPATH_ARTIFACT_CONFIGURATION_SLUG
  description               = "$env:GITHUB_REPOSITORY@$env:GITHUB_SHA run $env:GITHUB_RUN_ID"
  artifact                  = Get-Item -LiteralPath $Worker
}
$request = $submitted.Headers['Location'] | Select-Object -First 1
if (-not $request) {
  throw 'SignPath did not return a signing request location'
}
Write-Host "SignPath signing request: $request"

$deadline = (Get-Date).AddMinutes(30)
do {
  Start-Sleep -Seconds 10
  $status = Invoke-RestMethod -Uri $request -Headers $headers -MaximumRetryCount 5 -RetryIntervalSec 10
  Write-Host "SignPath status: $($status.status) ($($status.workflowStatus))"
} until ($status.isFinalStatus -or (Get-Date) -gt $deadline)
if ($status.status -ne 'Completed') {
  throw "SignPath signing request ended with $($status.status) ($($status.workflowStatus))"
}

$signed = Join-Path $env:RUNNER_TEMP "signed-$(Split-Path -Leaf $Worker)"
Invoke-WebRequest -Uri "$request/SignedArtifact" -Headers $headers -OutFile $signed -MaximumRetryCount 5 -RetryIntervalSec 10
$signature = Get-AuthenticodeSignature -LiteralPath $signed
if ($signature.SignerCertificate.Thumbprint -ne $expectedThumbprint) {
  throw 'SignPath returned an unexpected signer certificate'
}

$certificatePath = Join-Path $env:RUNNER_TEMP 'signpath-test-certificate.cer'
Export-Certificate -Cert $signature.SignerCertificate -FilePath $certificatePath | Out-Null
Import-Certificate -FilePath $certificatePath -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Import-Certificate -FilePath $certificatePath -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null
$signature = Get-AuthenticodeSignature -LiteralPath $signed
if ($signature.Status -ne 'Valid') {
  throw "UIAccess worker signature status is $($signature.Status)"
}
Copy-Item -LiteralPath $signed -Destination $Worker -Force
