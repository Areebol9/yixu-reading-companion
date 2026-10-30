'use strict';
const fs = require('node:fs');
const path = require('node:path');

// The selected project stays in place. Only this computer's selection is saved.
function readReadingProject(directory) {
  try {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || !fs.statSync(directory).isDirectory()) throw Error();
    const filename = path.join(directory, 'project.json');
    if (fs.statSync(filename).size > 65536) throw Error();
    const project = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (project?.schema !== 'yixu-reading-project-v1' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(project.archiveId) || typeof project.title !== 'string' || !project.title.trim() || !Number.isFinite(project.createdAt) || project.dataDirectory !== 'data' || project.nativeDirectory !== 'runtime') throw Error();
    if (!fs.statSync(path.join(directory, 'data', 'archives', project.archiveId, 'domain.sqlite')).isFile()) throw Error();
    return {directory: path.resolve(directory), archiveId: project.archiveId};
  } catch {
    throw Error('READING_PROJECT_UNAVAILABLE');
  }
}
function selectedReadingProject(dataRoot) {
  const filename = path.join(dataRoot, 'project-selection.json');
  let raw;
  try { raw = fs.readFileSync(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw Error('READING_PROJECT_SELECTION_UNAVAILABLE'); }
  try {
    const saved = JSON.parse(raw);
    if (saved?.schema !== 'yixu-reading-project-selection-v1') throw Error();
    return readReadingProject(saved.directory);
  } catch { throw Error('READING_PROJECT_SELECTION_UNAVAILABLE'); }
}
function saveReadingProjectSelection(dataRoot, project) {
  const filename = path.join(dataRoot, 'project-selection.json');
  if (!project) {
    try { fs.unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return;
  }
  const pending = filename + '.pending';
  fs.writeFileSync(pending, JSON.stringify({schema: 'yixu-reading-project-selection-v1', directory: project.directory}) + '\n', {mode: 0o600});
  fs.renameSync(pending, filename);
}
function readingProjectEnvironment(dataRoot, project) {
  return {
    YIXU_CLIENT_DATA_ROOT: dataRoot,
    YIXU_COMPANION_DATA_ROOT: project ? path.join(project.directory, 'data') : path.join(dataRoot, 'companion-host', 'data'),
    YIXU_COMPANION_HOME: project ? path.join(project.directory, 'runtime') : path.join(dataRoot, 'companion-host', 'dsh-home'),
    YIXU_OPENED_PROJECT_DIRECTORY: project?.directory ?? '',
    YIXU_OPENED_PROJECT_ARCHIVE_ID: project?.archiveId ?? '',
  };
}
module.exports = {readReadingProject, selectedReadingProject, saveReadingProjectSelection, readingProjectEnvironment};
