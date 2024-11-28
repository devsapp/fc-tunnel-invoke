import * as core from '@serverless-devs/core';
import Docker from 'dockerode';
import Container from 'dockerode';
import logger from '../../common/logger';
import { findPathsOutofSharedPaths } from './docker-support';
import { processorTransformFactory } from '../error-processor';
import { NasConfig } from '../interface/nas';
import * as nas from '../local-invoke/nas';
import path from 'path';
import { getRootBaseDir } from '../devs';
import * as fs from 'fs-extra';
import { generatePwdFile } from '../utils/passwd';
import * as dockerOpts from './docker-opts';
import { generateDebugEnv, generateVscodeDebugConfig } from '../local-invoke/debug';
import * as ip from 'ip';
import { ServiceConfig } from '../interface/fc-service';
import { addEnv, resolveLibPathsFromLdConf } from '../local-invoke/env';
import { FunctionConfig } from '../interface/fc-function';
import { isCustomContainerRuntime } from '../utils/runtime';
import { ICredentials } from '../../common/entity';
import { isAutoConfig, resolveAutoLogConfig } from '../definition';
import { LogConfig } from '../interface/sls';
import devnull from 'dev-null';

const _ = core.lodash;

const isWin: boolean = process.platform === 'win32';
const docker: any = new Docker();

let containers: any = new Set();
let streams: any = new Set();


export function generateRamdomContainerName(): string {
  return `fc_local_${new Date().getTime()}_${Math.random().toString(36).substr(2, 7)}`;
}

export async function pullImageIfNeed(imageUrl: string) {
  const fcCore = await core.loadComponent('devsapp/fc-core');
  await fcCore.pullImageIfNeed(docker, imageUrl);
}

export function generateDockerCmd(
  runtime: string,
  isLocalStartInit: boolean,
  functionConfig?: FunctionConfig,
  httpMode?: boolean,
  invokeInitializer = true,
  event = null,
): string[] {
  if (isCustomContainerRuntime(runtime)) {
    return genDockerCmdOfCustomContainer(functionConfig);
  } else if (isLocalStartInit) {
    return ['--server'];
  }
  return genDockerCmdOfNonCustomContainer(functionConfig, httpMode, invokeInitializer, event);
}

function genDockerCmdOfNonCustomContainer(functionConfig: FunctionConfig, httpMode: boolean, invokeInitializer = true, event = null): string[] {
  const cmd: string[] = ['-h', functionConfig.handler];

  // 如果提供了 event
  if (event !== null) {
    cmd.push('--event', Buffer.from(event).toString('base64'));
    cmd.push('--event-decode');
  } else {
    // always pass event using stdin mode
    cmd.push('--stdin');
  }

  if (httpMode) {
    cmd.push('--http');
  }

  const initializer = functionConfig.initializer;

  if (initializer && invokeInitializer) {
    cmd.push('-i', initializer);
  }

  const initializationTimeout = functionConfig.initializationTimeout;

  // initializationTimeout is defined as integer, see lib/validate/schema/function.js
  if (initializationTimeout) {
    cmd.push('--initializationTimeout', initializationTimeout.toString());
  }

  logger.debug(`docker cmd: ${cmd}`);

  return cmd;
}

function genDockerCmdOfCustomContainer(functionConfig: FunctionConfig): any {
  const command: any = functionConfig.customContainerConfig.command ? JSON.parse(functionConfig.customContainerConfig.command) : undefined;
  const args: any = functionConfig.customContainerConfig.args ? JSON.parse(functionConfig.customContainerConfig.args) : undefined;

  if (command && args) {
    return [...command, ...args];
  } else if (command) {
    return command;
  } else if (args) {
    return args;
  }
  return [];
}

export async function generateDockerEnvs(
  creds: ICredentials,
  region: string,
  baseDir: string,
  serviceName: string,
  serviceProps: ServiceConfig,
  functionName: string,
  functionProps: FunctionConfig,
  debugPort: number,
  httpParams: any,
  nasConfig: NasConfig | string,
  debugIde: any,
  debugArgs?: any,
): Promise<any> {
  const envs = {};

  if (httpParams) {
    Object.assign(envs, {
      FC_HTTP_PARAMS: httpParams,
    });
  }

  const confEnv = await resolveLibPathsFromLdConf(baseDir, functionProps.codeUri);

  Object.assign(envs, confEnv);

  const runtime: string = functionProps.runtime;

  if (debugPort && !debugArgs) {
    const debugEnv = generateDebugEnv(runtime, debugPort, debugIde);

    Object.assign(envs, debugEnv);
  } else if (debugArgs) {
    Object.assign(envs, {
      DEBUG_OPTIONS: debugArgs,
    });
  }

  Object.assign(envs, generateFunctionEnvs(functionProps));

  let logConfigInEnv: LogConfig;
  if (isAutoConfig(serviceProps?.logConfig)) {
    logConfigInEnv = resolveAutoLogConfig(creds?.AccountID, region, serviceName);
  } else {
    // @ts-ignore
    logConfigInEnv = serviceProps?.logConfig;
  }
  if (functionProps?.runtime.includes('java')) {
    Object.assign(envs, { fc_enable_new_java_ca: true });
  }
  Object.assign(envs, {
    local: true,
    FC_ACCESS_KEY_ID: creds?.AccessKeyID,
    FC_ACCESS_KEY_SECRET: creds?.AccessKeySecret,
    FC_SECURITY_TOKEN: creds?.SecurityToken,
    FC_ACCOUNT_ID: creds?.AccountID,
    FC_REGION: region,
    FC_FUNCTION_NAME: functionName,
    FC_HANDLER: functionProps.handler,
    FC_MEMORY_SIZE: functionProps.memorySize || 128,
    FC_TIMEOUT: functionProps.timeout || 3,
    FC_INITIALIZER: functionProps.initializer,
    FC_INITIALIZATION_TIMEOUT: functionProps.initializationTimeout || 3,
    FC_SERVICE_NAME: serviceName,
    FC_SERVICE_LOG_PROJECT: logConfigInEnv?.project,
    FC_SERVICE_LOG_STORE: logConfigInEnv?.logstore,
  });

  if (isCustomContainerRuntime(functionProps.runtime)) {
    return envs;
  }

  return addEnv(envs, {
    nasConfig,
    layers: functionProps.layers,
    runtime: functionProps.runtime,
  });
}

function generateFunctionEnvs(functionConfig: FunctionConfig): any {
  const environmentVariables = functionConfig.environmentVariables;

  if (!environmentVariables) {
    return {};
  }

  return Object.assign({}, environmentVariables);
}

export async function runContainer(opts, outputStream?: any, errorStream?: any, context?: any) {
  const container = await createContainer(opts);
  const attachOpts = {
    hijack: true,
    stream: true,
    stdin: true,
    stdout: true,
    stderr: true,
  };

  const stream = await container.attach(attachOpts);

  if (!outputStream) {
    outputStream = process.stdout;
  }

  if (!errorStream) {
    errorStream = process.stderr;
  }

  const errorTransform = processorTransformFactory({
    serviceName: context?.serviceName,
    functionName: context?.functionName,
    errorStream: errorStream,
  });

  if (!isWin) {
    container.modem.demuxStream(stream, outputStream, errorTransform);
  }

  await container.start();
  // dockerode bugs on windows. attach could not receive output and error
  if (isWin) {
    const logStream = await container.logs({
      stdout: true,
      stderr: true,
      follow: true,
    });

    container.modem.demuxStream(logStream, outputStream, errorTransform);
  }

  containers.add(container.id);
  streams.add(stream);
  return {
    container,
    stream,
  };
}

// todo: 当前只支持目录以及 jar。code uri 还可能是 oss 地址、目录、jar、zip?
export async function resolveCodeUriToMount(absCodeUri: string, readOnly = true): Promise<any> {
  if (!absCodeUri) {
    return null;
  }
  let target: string = null;

  const stats: any = await fs.lstat(absCodeUri);

  if (stats.isDirectory()) {
    target = '/code';
  } else {
    // could not use path.join('/code', xxx)
    // in windows, it will be translate to \code\xxx, and will not be recorgnized as a valid path in linux container
    target = path.posix.join('/code', path.basename(absCodeUri));
  }

  // Mount the code directory as read only
  return {
    Type: 'bind',
    Source: absCodeUri,
    Target: target,
    ReadOnly: readOnly,
  };
}

export async function isDockerToolBoxAndEnsureDockerVersion(): Promise<boolean> {
  const dockerInfo: any = await docker.info();

  await detectDockerVersion(dockerInfo.ServerVersion || '');

  const obj = (dockerInfo.Labels || [])
    .map((e) => _.split(e, '=', 2))
    .filter((e) => e.length === 2)
    .reduce((acc, cur) => ((acc[cur[0]] = cur[1]), acc), {});

  return process.platform === 'win32' && obj.provider === 'virtualbox';
}

async function detectDockerVersion(serverVersion: string): Promise<void> {
  let cur = serverVersion.split('.');
  // 1.13.1
  if (Number.parseInt(cur[0]) === 1 && Number.parseInt(cur[1]) <= 13) {
    throw new Error(`\nWe detected that your docker version is ${serverVersion}, for a better experience, please upgrade the docker version.`);
  }
}

async function createContainer(opts: any): Promise<any> {
  const isWin: boolean = process.platform === 'win32';
  const isMac: boolean = process.platform === 'darwin';

  if (opts && isMac) {
    if (opts.HostConfig) {
      const pathsOutofSharedPaths = await findPathsOutofSharedPaths(opts.HostConfig?.Mounts);
      if (isMac && pathsOutofSharedPaths.length > 0) {
        throw new Error(
          `Please add directory '${pathsOutofSharedPaths}' to Docker File sharing list, more information please refer to https://github.com/devsapp/fc/issues/867 `,
        );
      }
    }
  }
  const dockerToolBox = await isDockerToolBoxAndEnsureDockerVersion();

  let container;
  try {
    // see https://github.com/apocas/dockerode/pull/38
    container = await docker.createContainer(opts);
  } catch (ex) {
    if (ex.message.indexOf('invalid mount config for type') !== -1 && dockerToolBox) {
      throw new Error(
        `The default host machine path for docker toolbox is under 'C:\\Users', Please make sure your project is in this directory. If you want to mount other disk paths, please refer to https://github.com/devsapp/fc/issues/867 .`,
      );
    }
    if (ex.message.indexOf('drive is not shared') !== -1 && isWin) {
      throw new Error(`${ex.message}More information please refer to https://docs.docker.com/docker-for-windows/#shared-drives`);
    }
    throw ex;
  }
  return container;
}

export async function resolveNasConfigToMounts(
  baseDir: string,
  serviceName: string,
  nasConfig: NasConfig | string,
  nasBaseDir: string,
): Promise<any> {
  const nasMappings: any = await nas.convertNasConfigToNasMappings(nasBaseDir, nasConfig, serviceName);
  return convertNasMappingsToMounts(getRootBaseDir(baseDir), nasMappings);
}

function convertNasMappingsToMounts(baseDir: string, nasMappings: any): any {
  return nasMappings.map((nasMapping) => {
    // console.log('mounting local nas mock dir %s into container %s\n', nasMapping.localNasDir, nasMapping.remoteNasDir);
    return {
      Type: 'bind',
      Source: path.resolve(baseDir, nasMapping.localNasDir),
      Target: nasMapping.remoteNasDir,
      ReadOnly: false,
    };
  });
}

export function resolveLayerToMounts(absOptDir) {
  return {
    Type: 'bind',
    Source: absOptDir,
    Target: '/opt',
    ReadOnly: false
  };
}

export async function resolveTmpDirToMount(absTmpDir: string): Promise<any> {
  if (!absTmpDir) {
    return {};
  }
  return {
    Type: 'bind',
    Source: absTmpDir,
    Target: '/tmp',
    ReadOnly: false,
  };
}

export async function resolveDebuggerPathToMount(debuggerPath: string): Promise<any> {
  if (!debuggerPath) {
    return {};
  }
  const absDebuggerPath: string = path.resolve(debuggerPath);
  return {
    Type: 'bind',
    Source: absDebuggerPath,
    Target: '/tmp/debugger_files',
    ReadOnly: false,
  };
}

export async function resolvePasswdMount(): Promise<any> {
  if (process.platform === 'linux') {
    return {
      Type: 'bind',
      Source: await generatePwdFile(),
      Target: '/etc/passwd',
      ReadOnly: true,
    };
  }

  return null;
}

async function showDebugIdeTipsForVscode(
  serviceName: string,
  functionName: string,
  runtime: string,
  codeSource: string,
  debugPort?: number,
): Promise<void> {
  const vscodeDebugConfig = await generateVscodeDebugConfig(serviceName, functionName, runtime, codeSource, debugPort);

  // todo: auto detect .vscode/launch.json in codeuri path.
  logger.log('You can paste these config to .vscode/launch.json, and then attach to your running function', 'yellow');
  logger.log('///////////////// config begin /////////////////');
  logger.log(JSON.stringify(vscodeDebugConfig, null, 4));
  logger.log('///////////////// config end /////////////////');
}

export async function writeDebugIdeConfigForVscode(
  baseDir: string,
  serviceName: string,
  functionName: string,
  runtime: string,
  codeSource: string,
  debugPort?: number,
): Promise<void> {
  const configJsonFolder: string = path.join(baseDir, '.vscode');
  const configJsonFilePath: string = path.join(configJsonFolder, 'launch.json');
  try {
    await fs.ensureDir(path.dirname(configJsonFilePath));
  } catch (e) {
    logger.warn(`Ensure directory: ${configJsonFolder} failed.`);
    await showDebugIdeTipsForVscode(serviceName, functionName, runtime, codeSource, debugPort);
    logger.debug(`Ensure directory: ${configJsonFolder} failed, error: ${e}`);
    return;
  }
  const vscodeDebugConfig = await generateVscodeDebugConfig(serviceName, functionName, runtime, codeSource, debugPort);
  if (fs.pathExistsSync(configJsonFilePath) && fs.lstatSync(configJsonFilePath).isFile()) {
    // 文件已存在则对比文件内容与待写入内容，若不一致提示用户需要手动写入 launch.json
    const configInJsonFile = JSON.parse(await fs.readFile(configJsonFilePath, { encoding: 'utf8' }));
    if (_.isEqual(configInJsonFile, vscodeDebugConfig)) {
      return;
    }
    logger.warn(`File: ${configJsonFilePath} already exists, please overwrite it with the following config.`);
    await showDebugIdeTipsForVscode(serviceName, functionName, runtime, codeSource, debugPort);
    return;
  }
  try {
    await fs.writeFile(configJsonFilePath, JSON.stringify(vscodeDebugConfig, null, '  '), { encoding: 'utf8', flag: 'w' });
  } catch (e) {
    logger.warn(`Write ${configJsonFilePath} failed.`);
    await showDebugIdeTipsForVscode(serviceName, functionName, runtime, codeSource, debugPort);
    logger.debug(`Write ${configJsonFilePath} failed, error: ${e}`);
  }
}

export async function showDebugIdeTipsForPycharm(codeSource: string, debugPort: number): Promise<void> {
  const stats = await fs.lstat(codeSource);

  if (!stats.isDirectory()) {
    codeSource = path.dirname(codeSource);
  }

  logger.log(
    `\n========= Tips for PyCharm remote debug =========
Local host name: ${ip.address()}
Port           : ${debugPort}
Path mappings  : ${codeSource}=/code

Debug Code needed to:
 1. Install pydevd-pycharm:
 
 pip install pydevd-pycharm~=203.5981.165
 
 2. copy to your function code:

import pydevd_pycharm
pydevd_pycharm.settrace('${ip.address()}', port=${debugPort}, stdoutToServer=True, stderrToServer=True)

=========================================================================\n`,
    'yellow',
  );
}

function writeEventToStreamAndClose(stream, event) {
  if (event) {
    stream.write(event);
  }

  stream.end();
}

// outputStream, errorStream used for http invoke
// because agent is started when container running and exec could not receive related logs
export async function startContainer(opts: any, outputStream?: any, errorStream?: any, context?: any): Promise<any> {
  const container = await createContainer(opts);

  containers.add(container.id);

  try {
    await container.start({});
  } catch (err) {
    logger.error(err);
  }

  const logs: any = outputStream || errorStream;

  if (logs) {
    if (!outputStream) {
      outputStream = devnull();
    }

    if (!errorStream) {
      errorStream = devnull();
    }

    // dockerode bugs on windows. attach could not receive output and error, must use logs
    const logStream = await container.logs({
      stdout: true,
      stderr: true,
      follow: true,
    });

    container.modem.demuxStream(
      logStream,
      outputStream,
      processorTransformFactory({
        serviceName: context.serviceName,
        functionName: context.functionName,
        errorStream,
      }),
    );
  }

  return {
    containerId: container?.id,
    stop: async () => {
      logger.debug(`Stopping container: ${container.id}`);
      await container.stop();
      containers.delete(container.id);
    },

    kill: async () => {
      logger.debug(`Killing container: ${container.id}`);
      await container.kill();
      containers.delete(container.id);
    },

    exec: async (
      cmd,
      { cwd = '', env = {}, outputStream = process.stdout, errorStream = process.stderr, verbose = false, context = {}, event = null } = {},
    ) => {
      const stdin = event ? true : false;

      const options: any = {
        Env: dockerOpts.resolveDockerEnv(env),
        Tty: false,
        AttachStdin: stdin,
        AttachStdout: true,
        AttachStderr: true,
        WorkingDir: cwd,
        User: 'root',
      };
      if (cmd !== []) {
        options.Cmd = cmd;
      }

      // docker exec
      logger.debug(`docker exec opts: ${JSON.stringify(options, null, 4)}`);

      const exec = await container.exec(options);

      const stream = await exec.start({ hijack: true, stdin });

      // todo: have to wait, otherwise stdin may not be readable
      await new Promise((resolve) => setTimeout(resolve, 30));

      if (event !== null) {
        writeEventToStreamAndClose(stream, event);
      }

      if (!outputStream) {
        outputStream = process.stdout;
      }

      if (!errorStream) {
        errorStream = process.stderr;
      }

      if (verbose) {
        container.modem.demuxStream(stream, outputStream, errorStream);
      } else {
        container.modem.demuxStream(stream, devnull(), errorStream);
      }

      return await waitForExec(exec);
    },
  };
}

async function waitForExec(exec) {
  return await new Promise((resolve, reject) => {
    // stream.on('end') could not receive end event on windows.
    // so use inspect to check exec exit
    function waitContainerExec() {
      exec.inspect((err, data) => {
        if (data?.Running) {
          setTimeout(waitContainerExec, 100);
          return;
        }
        if (err) {
          reject(err);
        } else if (data.ExitCode !== 0) {
          reject(`${data.ProcessConfig.entrypoint} exited with code ${data.ExitCode}`);
        } else {
          resolve(data.ExitCode);
        }
      });
    }
    waitContainerExec();
  });
}

export async function stopContainer(container: Container): Promise<void> {
  let stopVm: any = core.spinner(`Stopping the container: ${container.id}`);
  try {
    await container.stop();
    stopVm.succeed(`Stop container succeed.`);
  } catch (e) {
    stopVm.fail(`Failed to stop the container.`);
    logger.debug(`Stop the container: ${container.id} failed, error: ${e}`);
    stopVm = core.spinner(`Killing the container: ${container.id}`);
    try {
      await container.kill();
      stopVm.succeed(`Kill container succeed`);
    } catch (e) {
      stopVm.fail(`Failed to kill the container.Please stop it manually.`);
      logger.debug(`Kill proxy container: ${container.id} failed, error: ${e}`);
    }
  }
}
