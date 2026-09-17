{{/*
Expand the name of the chart.
*/}}
{{- define "brainmcp.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name, truncated to the 63 characters DNS labels allow.
*/}}
{{- define "brainmcp.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "brainmcp.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "brainmcp.labels" -}}
helm.sh/chart: {{ include "brainmcp.chart" . }}
{{ include "brainmcp.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "brainmcp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "brainmcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "brainmcp.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "brainmcp.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "brainmcp.secretName" -}}
{{- default (include "brainmcp.fullname" .) .Values.secrets.existingSecret }}
{{- end }}

{{- define "brainmcp.isOpenShift" -}}
{{- if .Capabilities.APIVersions.Has "route.openshift.io/v1" }}true{{- end }}
{{- end }}

{{/*
Pod security context. OpenShift's SCC assigns the UID, and naming one outside
its range gets the pod rejected — so emit nothing there. Elsewhere the image's
default user is root, which runAsNonRoot refuses, so pin a non-root UID.
*/}}
{{- define "brainmcp.podSecurityContext" -}}
{{- if .Values.podSecurityContext }}
{{- toYaml .Values.podSecurityContext }}
{{- else if not (include "brainmcp.isOpenShift" .) }}
runAsUser: 10001
runAsGroup: 10001
fsGroup: 10001
{{- end }}
{{- end }}
