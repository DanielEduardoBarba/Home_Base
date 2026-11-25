#!/usr/bin/env bash
# Batchmode WebGL build for a Unity project (no Hub GUI / license changes).
# Requires WebGL module + an EditorBuildScript.BuildWebGL method in the project.
#
# Project lock: if a Coplay bridge Editor has this project open, stop it first
# (live-webgl.sh does this). Do not run concurrent Editors on the same path.
set -euo pipefail

# Resolve seat home even when systemd/service HOME=/root
if [[ -z "${HOME:-}" || "$HOME" == "/root" ]]; then
  if [[ -d /home/daniel ]]; then HOME=/home/daniel; fi
fi

UNITY_DEFAULT="${HOME}/Unity/Hub/Editor/6000.6.4f1/Editor/Unity"
UNITY="${UNITY_EDITOR:-${UNITY:-$UNITY_DEFAULT}}"
# Fall back to any installed Hub editor if the pinned path is missing
if [[ ! -x "$UNITY" ]]; then
  for cand in "${HOME}/Unity/Hub/Editor"/*/Editor/Unity; do
    if [[ -x "$cand" ]]; then UNITY="$cand"; break; fi
  done
fi
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

# Ensure runtime bootstrap + build script exist (idempotent).
mkdir -p "$PROJECT/Assets/Scripts" "$PROJECT/Assets/Editor" "$PROJECT/Assets/Scenes"

BOOTSTRAP="$PROJECT/Assets/Scripts/HelloDevConBootstrap.cs"
if [[ ! -f "$BOOTSTRAP" ]]; then
  cat >"$BOOTSTRAP" <<'CS'
using UnityEngine;

namespace HomeBase.Sample
{
    /// <summary>Rotating cube + "Hello from DevCon1" — phone WebGL smoke scene.</summary>
    public class HelloDevConBootstrap : MonoBehaviour
    {
        Transform _cube;

        void Start()
        {
            var lightGo = new GameObject("Directional Light");
            var light = lightGo.AddComponent<Light>();
            light.type = LightType.Directional;
            lightGo.transform.rotation = Quaternion.Euler(50f, -30f, 0f);

            var cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
            cube.name = "DevConCube";
            cube.transform.position = new Vector3(0f, 0.25f, 0f);
            _cube = cube.transform;

            var camGo = GameObject.Find("Main Camera");
            if (camGo == null)
            {
                camGo = new GameObject("Main Camera");
                camGo.AddComponent<Camera>();
                camGo.tag = "MainCamera";
            }
            camGo.transform.position = new Vector3(0f, 1.2f, -4f);
            camGo.transform.LookAt(cube.transform);

            var textGo = new GameObject("HelloText");
            textGo.transform.position = new Vector3(0f, 1.6f, 0f);
            var tm = textGo.AddComponent<TextMesh>();
            tm.text = "Hello from DevCon1";
            tm.fontSize = 48;
            tm.characterSize = 0.08f;
            tm.anchor = TextAnchor.MiddleCenter;
            tm.alignment = TextAlignment.Center;
            tm.color = Color.white;
            textGo.transform.LookAt(camGo.transform);
            textGo.transform.Rotate(0f, 180f, 0f);
        }

        void Update()
        {
            if (_cube != null) _cube.Rotate(0f, 45f * Time.deltaTime, 0f, Space.World);
        }
    }
}

CS
fi

SCRIPT="$PROJECT/Assets/Editor/EditorBuildScript.cs"
cat >"$SCRIPT" <<'CS'
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using HomeBase.Sample;

namespace HomeBase.Editor
{
    public static class EditorBuildScript
    {
        const string ScenePath = "Assets/Scenes/DevCon1.unity";

        public static void EnsureSampleScene()
        {
            Directory.CreateDirectory("Assets/Scenes");
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var go = new GameObject("HelloDevCon");
            go.AddComponent<HelloDevConBootstrap>();
            EditorSceneManager.SaveScene(scene, ScenePath);
            var list = new[] { new EditorBuildSettingsScene(ScenePath, true) };
            EditorBuildSettings.scenes = list;
            AssetDatabase.SaveAssets();
            Debug.Log("Ensured sample scene " + ScenePath);
        }

        public static void BuildWebGL()
        {
            if (!File.Exists(ScenePath))
            {
                EnsureSampleScene();
            }
            else if (EditorBuildSettings.scenes == null || EditorBuildSettings.scenes.Length == 0)
            {
                EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
            }

            var outDir = Path.GetFullPath("Builds/WebGL");
            Directory.CreateDirectory(outDir);
            var scenes = EditorBuildSettings.scenes;
            if (scenes == null || scenes.Length == 0)
            {
                Debug.LogError("No scenes found for WebGL build");
                EditorApplication.Exit(1);
                return;
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

echo "Building WebGL → $OUT (log $LOG)"
"$UNITY" -batchmode -nographics -quit \
  -projectPath "$PROJECT" \
  -buildTarget WebGL \
  -executeMethod "$METHOD" \
  -logFile "$LOG"

echo "WebGL build finished. Serve with: scripts/unity/serve-webgl.sh <port> \"$OUT\""
echo "Live watch+serve: scripts/unity/live-webgl.sh <port>"
