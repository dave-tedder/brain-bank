# Brain-Bank GCP Resource Provisioning Script
# Targets file: gcp/gcp-resource-setup.ps1
#
# This script automates the creation of all GCP resources required by Brain-Bank:
#   1. Cloud SQL for PostgreSQL Instance
#   2. GCS Deliverables Bucket
#   3. Artifact Registry Docker Repository
#   4. Runner Service Account & IAM policy bindings
#   5. Secret Manager secret containers and initial version seeding
#
# Prerequisite: Install Google Cloud SDK and authenticate (gcloud auth login)

$ProjectId = Read-Host "Enter your GCP Project ID"
$Region = Read-Host "Enter target GCP Region (default: us-east1)"
if ([string]::IsNullOrEmpty($Region)) { $Region = "us-east1" }

$DbPassword = Read-Host "Enter a strong database password for the postgres user"
if ([string]::IsNullOrEmpty($DbPassword)) {
    Write-Error "Database password cannot be empty."
    exit 1
}

# Configure local gcloud CLI context
Write-Host "Configuring project context to $ProjectId..." -ForegroundColor Cyan
gcloud config set project $ProjectId

# 1. Cloud SQL for PostgreSQL (Sandbox / db-f1-micro)
Write-Host "Creating Cloud SQL PostgreSQL instance (brainbank-db)... This will take a few minutes..." -ForegroundColor Cyan
gcloud sql instances create brainbank-db `
  --database-version=POSTGRES_15 `
  --tier=db-f1-micro `
  --region=$Region `
  --root-password=$DbPassword

# Retrieve SQL Instance Connection Details
$DbIp = gcloud sql instances describe brainbank-db --format="value(ipAddresses[0].ipAddress)"
$DbUrl = "postgresql://postgres:$($DbPassword)@$($DbIp):5432/postgres"

# 2. Google Cloud Storage
$BucketName = "brainbank-deliverables-$ProjectId"
Write-Host "Creating GCS Bucket ($BucketName)..." -ForegroundColor Cyan
gcloud storage buckets create "gs://$BucketName" `
  --location=$Region `
  --uniform-bucket-level-access

# 3. Artifact Registry Repository
Write-Host "Creating Artifact Registry Docker repository (bb-repo)..." -ForegroundColor Cyan
gcloud artifacts repositories create bb-repo `
  --repository-format=docker `
  --location=$Region `
  --description="Docker repository for Brain-Bank images"

# 4. Service Account & IAM Bindings
Write-Host "Creating Service Account (brainbank-runner)..." -ForegroundColor Cyan
gcloud iam service-accounts create brainbank-runner `
  --display-name="Brain-Bank Cloud Run Executor"

Write-Host "Binding IAM roles..." -ForegroundColor Cyan
gcloud projects add-iam-policy-binding $ProjectId `
  --member="serviceAccount:brainbank-runner@$ProjectId.iam.gserviceaccount.com" `
  --role="roles/secretmanager.secretAccessor"

gcloud storage buckets add-iam-policy-binding "gs://$BucketName" `
  --member="serviceAccount:brainbank-runner@$ProjectId.iam.gserviceaccount.com" `
  --role="roles/storage.objectAdmin"

# 5. Secret Manager Seeding
Write-Host "Creating Secret Manager secrets and seeding initial versions..." -ForegroundColor Cyan

$Secrets = @{
    "brainbank-database-url"      = $DbUrl
    "brainbank-jwt-secret"         = [Convert]::ToBase64String((1..32 | % { [byte](Get-Random -Min 0 -Max 256) }))
    "brainbank-mcp-access-key"    = -join ((1..32) | % { "{0:x}" -f (Get-Random -Min 0 -Max 16) })
    "brainbank-openrouter-key"    = "placeholder_openrouter_key"
    "brainbank-dashboard-password" = "placeholder_dashboard_password"
    "brainbank-postgrest-url"     = "placeholder_url_will_be_overwritten_after_deploy"
    "brainbank-mcp-url"           = "placeholder_url_will_be_overwritten_after_deploy"
}

foreach ($Key in $Secrets.Keys) {
    Write-Host "Provisioning secret: $Key..." -ForegroundColor Yellow
    # Create the secret container
    gcloud secrets create $Key --replication-policy="automatic"
    
    # Add the initial secret value as version 1
    $Value = $Secrets[$Key]
    $Bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $TempFile = [System.IO.Path]::GetTempFileName()
    [System.IO.File]::WriteAllBytes($TempFile, $Bytes)
    gcloud secrets versions add $Key --data-file=$TempFile
    Remove-Item $TempFile
}

Write-Host "`nGCP Infrastructure Setup Complete!" -ForegroundColor Green
Write-Host "Database URL: $DbUrl" -ForegroundColor Cyan
Write-Host "Deliverables Bucket: gs://$BucketName" -ForegroundColor Cyan
Write-Host "`nNext Steps:" -ForegroundColor Yellow
Write-Host "1. Go to Secret Manager in GCP console and update the 'brainbank-openrouter-key' and 'brainbank-dashboard-password' secret values with your real credentials."
Write-Host "2. Run 'gcloud builds submit --config gcp/cloudbuild.yaml --project=$ProjectId .' to deploy the services."
