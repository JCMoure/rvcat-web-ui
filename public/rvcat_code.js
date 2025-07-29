const GET_AVAIL_PROGRAMS = `import rvcat
rvcat._program.list_programs_json()
`

const GET_AVAIL_PROCESSORS = `import rvcat
rvcat._processor.list_processors_json()
`

// SHOW program
const PROG_SHOW              = 'str(rvcat._program)'
const PROG_SHOW_DEPENDENCIES = `rvcat._program.show_dependencies()`
const PROG_SHOW_DEPENDENCIES_GRAPHVIZ = `rvcat._program.get_dependencies_grapviz(num_iters=3)`
const RUN_PROGRAM_TIMELINE = 'rvcat._scheduler.format_timeline()'
const RUN_PROGRAM_ANALYSIS = 'rvcat._scheduler.format_analysis_json()'
const RUN_PROGRAM_MEMTRACE = 'rvcat._scheduler.format_memtrace()'


function prog_show_dependencies_graphviz(num_iters) {
    return `rvcat._program.get_dependencies_grapviz(num_iters=${num_iters})`
}

const PROG_SHOW_CRITICAL_PATHS_GRAPHVIZ = `rvcat._program.get_recurrent_paths_graphviz()`
const PROG_SHOW_ANNOTATED    = `rvcat._program.annotate_action()`
const PROG_SHOW_EXECUTION    = `rvcat._program.annotate_execution()`
const PROG_SHOW_MEMORY       = `rvcat._program.show_memory_trace()`
const PROG_SHOW_STATIC_PERFORMANCE = `rvcat._program.show_static_performance_analysis()`

const SHOW_TIMELINE = 'rvcat._scheduler.format_timeline()'

function show_timeline(num_iters) {
    return `rvcat._scheduler.format_timeline(niters=${num_iters})`
}

// SHOW processor
const SHOW_PROCESSOR = 'rvcat._processor.json()'

const GET_PROGRAM_JSON = 'rvcat._program.json()'

// SHOW isa
const SHOW_ISA = 'str(rvcat._isa)'

// RUN program
const RUN_PROGRAM_PREAMBLE = function() {
    let res = `rvcat._scheduler.load_program(rvcat._program, iterations=${currentIterations()}, window_size=${currentROBSize()})\n`
    return res;
}

function addModifiedProcessor(config){
  let res = `rvcat._processor.import_processor_json(${JSON.stringify(config)})`;
  return res;
}

function addNewProgram(config){
  let res = `rvcat._program.import_program_json(${config})`;
  return res;
}

const RVCAT_HEADER = function() {
    let proc = currentProcessor();
    let prog = currentProgram();
    let res = `import rvcat\n`;
    if (proc !== undefined) {
      res += `rvcat._processor.load_processor('${currentProcessor()}')\n`

    }
    if (prog !== undefined) {
    res += `rvcat._program.load_program('${currentProgram()}')\n`
    res += RUN_PROGRAM_PREAMBLE();
    }
    return res;
}
