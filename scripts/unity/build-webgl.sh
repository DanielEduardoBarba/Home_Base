#!/usr/bin/env bash
# Batchmode WebGL build for a Unity project (no Hub GUI / license changes).
# Requires WebGL module + an EditorBuildScript.BuildWebGL method in the project.
set -euo pipefail

UNITY_DEFAULT="${HOME}/Unity/Hub/Editor/6000.6.4f1/Editor/Unity"
UNITY="${UNITY_EDITOR:-${UNITY:-$UNITY_DEFAULT}}"
if [[ -n "${1:-}" ]]; then
  PROJECT="$1"
elif [[ -n "${UNITY_PROJECT:-}" ]]; then
  PROJECT="$UNITY_PROJECT"
elif [[ -f "${PWD}/ProjectSettings/ProjectVersion.txt" ]]; then
  PROJECT="$PWD"
else
  PROJECT="${HOME}/MCP_WORKSPACES/unity-sample"
fi
OUT="${2:-${PROJECT}/Builds/WebGL}"
LOG="${UNITY_WEBGL_LOG:-${HOME}/.cache/homebase-unity/webgl-build.log}"
METHOD="${UNITY_WEBGL_METHOD:-HomeBase.Editor.EditorBuildScript.BuildWebGL}"

mkdir -p "$(dirname "$LOG")" "$OUT"

[[ -x "$UNITY" ]] || { echo "error: Unity not found at $UNITY" >&2; exit 1; }
[[ -f "$PROJECT/ProjectSettings/ProjectVersion.txt" ]] || {
  echo "error: not a Unity project: $PROJECT" >&2
  exit 1
}

# Ensure a minimal build script exists (idempotent).
SCRIPT_DIR="$PROJECT/Assets/Editor"
SCRIPT="$SCRIPT_DIR/EditorBuildScript.cs"
if [[ ! -f "$SCRIPT" ]]; then
  mkdir -p "$SCRIPT_DIR"
  cat >"$SCRIPT" <<'CS'
using System.IO;
using UnityEditor;
using UnityEngine;

namespace HomeBase.Editor
{
    public static class EditorBuildScript
    {
        public static void BuildWebGL()
        {
            var outDir = Path.GetFullPath("Builds/WebGL");
            Directory.CreateDirectory(outDir);
            var scenes = EditorBuildSettings.scenes;
            if (scenes == null || scenes.Length == 0)
            {
                var guids = AssetDatabase.FindAssets("t:Scene");
                if (guids.Length == 0)
                {
                    Debug.LogError("No scenes found for WebGL build");
                    EditorApplication.Exit(1);
                    return;
                }
                var path = AssetDatabase.GUIDToAssetPath(guids[0]);
                scenes = new[] { new EditorBuildSettingsScene(path, true) };
                EditorBuildSettings.scenes = scenes;
            }
            var opts = new BuildPlayerOptions
            {
                scenes = System.Array.ConvertAll(scenes, s => s.path),
                locationPathName = outDir,
                target = BuildTarget.WebGL,
                options = BuildOptions.None,
            };
            var report = BuildPipeline.BuildPlayer(opts);
            var code = report.summary.result == UnityEditor.Build.Reporting.BuildResult.Succeeded ? 0 : 1;
            EditorApplication.Exit(code);
        }
    }
}
CS
fi

echo "Building WebGL → $OUT (log $LOG)"
"$UNITY" -batchmode -nographics -quit \
  -projectPath "$PROJECT" \
  -buildTarget WebGL \
  -executeMethod "$METHOD" \
  -logFile "$LOG"

echo "WebGL build finished. Serve with: npx --yes serve -l 8410 \"$OUT\""
echo "Note: live reload / phone iframe wiring is Step 5 — this script only produces Builds/WebGL."
