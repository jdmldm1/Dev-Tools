# Reference validator for cross-checking the XSD explorer: validates every *.xml in -XmlDir against a schema using .NET's
# System.Xml.Schema (the same engine behind xsd.exe / PowerShell [xml].Validate). Output, one line per file: name<TAB>OK|ERR<TAB>first message
#   powershell -File tests/dotnet-validate.ps1 -SchemaDir <dir> -XmlDir <dir> [-Main UCI_MessageDefinitions_v2_6_0.xsd]
param(
  [Parameter(Mandatory)][string]$SchemaDir,
  [Parameter(Mandatory)][string]$XmlDir,
  [string]$Main = 'UCI_MessageDefinitions_v2_6_0.xsd'
)
$ErrorActionPreference = 'Stop'
$set = New-Object System.Xml.Schema.XmlSchemaSet
$set.XmlResolver = New-Object System.Xml.XmlUrlResolver
$mainPath = (Resolve-Path (Join-Path $SchemaDir $Main)).Path
$sr = [System.Xml.XmlReader]::Create($mainPath)       # BaseURI lets xs:include / xs:import resolve relative to this file
try { $schema = [System.Xml.Schema.XmlSchema]::Read($sr, $null) } finally { $sr.Close() }
[void]$set.Add($schema)
$set.Compile()

$global:vErrs = New-Object System.Collections.ArrayList
$handler = [System.Xml.Schema.ValidationEventHandler]{ param($s, $e) [void]$global:vErrs.Add($e.Message) }

Get-ChildItem -LiteralPath $XmlDir -Filter *.xml | ForEach-Object {
  $global:vErrs.Clear()
  $settings = New-Object System.Xml.XmlReaderSettings
  $settings.ValidationType = [System.Xml.ValidationType]::Schema
  $settings.Schemas = $set
  $settings.ValidationFlags = $settings.ValidationFlags -bor [System.Xml.Schema.XmlSchemaValidationFlags]::ReportValidationWarnings   # unknown root element => reported, like xmllint
  $settings.add_ValidationEventHandler($handler)
  $reader = $null
  try {
    $reader = [System.Xml.XmlReader]::Create($_.FullName, $settings)
    while ($reader.Read()) { }
  } catch {
    [void]$global:vErrs.Add('XML: ' + $_.Exception.Message)
  } finally { if ($reader) { $reader.Close() } }
  $first = if ($global:vErrs.Count) { ($global:vErrs[0] -replace "[\r\n\t]+", ' ') } else { '' }
  '{0}{1}{2}{1}{3}' -f $_.Name, "`t", $(if ($global:vErrs.Count) { 'ERR' } else { 'OK' }), $first
}
