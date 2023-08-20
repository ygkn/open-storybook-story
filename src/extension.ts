import * as vscode from "vscode";

import { loadStoryUrlGetter } from "@/storybook";

import { isStorybookRunning, waitForStorybookRunning } from "./server-checking";

type WorkspaceCacheItem = (editor: vscode.TextEditor | undefined) => unknown;

const workspaceCache = new Map<string, WorkspaceCacheItem>();

const getOrFallbackFromWorkspaceCache = async (
  key: string,
  fallback: () => Promise<WorkspaceCacheItem | undefined>,
): Promise<WorkspaceCacheItem | undefined> => {
  const cached = workspaceCache.get(key);

  if (cached !== undefined) {
    return cached;
  }

  const fallbackResult = await fallback();

  if (!fallbackResult) {
    return;
  }

  workspaceCache.set(key, fallbackResult);

  return fallbackResult;
};

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;

  if (!workspaceUri) {
    await vscode.window.showErrorMessage("please open a folder as workspace");
    return;
  }

  const workingDir = workspaceUri.fsPath;

  let storyUrl: string | null = null;

  let storybookConfigWatcher: vscode.FileSystemWatcher | undefined;

  const reload = async ({ noCache }: { noCache?: boolean } = {}) => {
    if (noCache) {
      workspaceCache.delete(workingDir);
    }

    const setActiveFileUrl = await getOrFallbackFromWorkspaceCache(
      workingDir,
      async () => {
        storybookConfigWatcher?.dispose();

        const config = vscode.workspace.getConfiguration(
          "storybook-opener.storybookOption",
        );

        const configDirUri = vscode.Uri.joinPath(
          workspaceUri,
          config.get<string>("configDir")!,
        );

        const configDir = configDirUri.fsPath;

        storybookConfigWatcher = vscode.workspace.createFileSystemWatcher(
          vscode.Uri.joinPath(configDirUri, "**").fsPath,
        );

        context.subscriptions.push(storybookConfigWatcher);

        storybookConfigWatcher.onDidCreate(() => reload({ noCache: true }));
        storybookConfigWatcher.onDidChange(() => reload({ noCache: true }));
        storybookConfigWatcher.onDidDelete(() => reload({ noCache: true }));

        try {
          const getStoryUrlFromPath = await loadStoryUrlGetter(
            {
              configDir,
              workingDir,
            },
            () => {
              const config = vscode.workspace.getConfiguration(
                "storybook-opener.storybookOption",
              );
              return {
                port: config.get<number>("port")!,
                host: config.get<string>("host")!,
                https: config.get<boolean>("https")!,
              };
            },
          );

          console.log("storybook-opener: READY!!");

          return async (editor) => {
            storyUrl =
              (editor &&
                (await getStoryUrlFromPath(editor.document.uri.fsPath))) ??
              null;

            vscode.commands.executeCommand(
              "setContext",
              "storybook-opener.isActiveEditorCsf",
              storyUrl !== null,
            );
          };
        } catch (e) {
          // TODO: error handling when storybook config file not found

          console.log(e);

          return;
        }
      },
    );

    setActiveFileUrl?.(vscode.window.activeTextEditor);
  };

  reload();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("storybook-opener.storybookOption.configDir")
      ) {
        reload({ noCache: true });
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      workspaceCache.get(workingDir)?.(editor);
    }),
    vscode.commands.registerCommand("storybook-opener.open", async () => {
      if (workspaceCache.get(workingDir) === undefined) {
        await vscode.window.showErrorMessage(
          [
            "Something wrong when loading main config.",
            `Check your config directory ${vscode.workspace
              .getConfiguration("storybook-opener.storybookOption")
              .get("configDir")!} is exists and valid.`,
          ].join(" "),
        );
      }

      if (storyUrl === null) {
        await vscode.window.showInformationMessage(
          [
            "Something went wrong when get or load yor story/docs file.",
            "Check opening file is valid or same name to story file.",
          ].join(" "),
        );
        return;
      }

      const storybookStarted = await isStorybookRunning(storyUrl);

      if (!storybookStarted) {
        await vscode.window
          .showInformationMessage(
            "Storybook Server seems to have not been started yet. Would you like to start?",
            "Yes",
            "No",
          )
          .then(async (answer) => {
            if (answer !== "Yes") {
              return;
            }

            const config = vscode.workspace.getConfiguration(
              "storybook-opener.storybookOption",
            );
            const httpsOption = config.get<boolean>("https") ? "--https" : "";
            const hostOption =
              config.get<string>("host") === "localhost"
                ? ""
                : `--host ${config.get<string>("host")}`;
            const portOption = `-p ${config.get<number>("port")}`;
            const startCommand = config.get<string>("startCommand");

            const options = [httpsOption, hostOption, portOption, "--no-open"]
              .filter(Boolean)
              .join(" ");

            const command = startCommand || `npx storybook dev ${options}`;

            const newTerminal = vscode.window.createTerminal({
              name: "Run Storybook",
            });
            newTerminal.show();
            newTerminal.sendText(command, true);

            if (storyUrl) {
              await waitForStorybookRunning(storyUrl);
            }
          });
      }

      vscode.env.openExternal(vscode.Uri.parse(storyUrl));
    }),
  );
}

export function deactivate() {
  //
}
