export interface SshTransportOptions {
  target: string;
  port?: number;
  identityFile?: string;
}

export interface BuildPythonDaemonCommandOptions {
  pythonBin: string;
  scriptPath: string;
  pythonArgs?: string[];
  ssh?: SshTransportOptions;
}

export interface SpawnCommand {
  command: string;
  args: string[];
}

export function buildPythonDaemonCommand(options: BuildPythonDaemonCommandOptions): SpawnCommand {
  const pythonArgs = ["-u", options.scriptPath, ...(options.pythonArgs ?? [])];

  if (!options.ssh) {
    return {
      command: options.pythonBin,
      args: pythonArgs,
    };
  }

  const sshArgs = ["-T"];
  if (options.ssh.port) {
    sshArgs.push("-p", String(options.ssh.port));
  }
  if (options.ssh.identityFile) {
    sshArgs.push("-i", options.ssh.identityFile);
  }

  sshArgs.push(options.ssh.target, options.pythonBin, ...pythonArgs);

  return {
    command: "ssh",
    args: sshArgs,
  };
}
