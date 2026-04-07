const { exec } = require('child_process');
const util = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const _pLimitMod = require('p-limit');
const pLimit = _pLimitMod.default || _pLimitMod;

const execPromise = util.promisify(exec);

// Concurrency limit: max N simultaneous Docker executions per process
const CONCURRENCY = parseInt(process.env.CODE_EXEC_CONCURRENCY, 10) || 5;
const execLimit = pLimit(CONCURRENCY);

class CodeExecutionService {
  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'code-exam-temp');
    this.initTempDir();
  }

  // Format error messages like standard coding platforms
  // Helper method to detect if text contains formatted error messages
  isFormattedError(text) {
    if (!text) return false;
    return text.includes('🐍') || text.includes('☕') || text.includes('🔧') || text.includes('🟨') || 
           text.includes('Error:') || text.includes('Exception') || text.includes('Traceback');
  }

  formatError(error, language) {
      if (!error) return '';

      // Only format the error message, don't remove the actual error content
      let formattedError = error
        .replace(/docker run --rm --memory=256m.*?(?=\n|$)/g, '') // Remove docker command lines
        .replace(/^.*alpine.*$/gm, '') // Remove alpine references
        .replace(/docker: Error response from daemon:.*$/gm, '')
        .replace(/Unable to find image.*$/gm, '')
        .trim();

      // Language-specific error formatting with line numbers
      if (language === 'python') {
        return this.formatPythonError(formattedError);
      } else if (language === 'java') {
        return this.formatJavaError(formattedError);
      } else if (language === 'cpp') {
        return this.formatCppError(formattedError);
      } else if (language === 'javascript') {
        return this.formatJavaScriptError(formattedError);
      }

      // Generic cleanup for unknown languages
      formattedError = formattedError
        .replace(/^\s*[\r\n]/gm, '') // Remove empty lines
        .replace(/\s+/g, ' ') // Replace multiple spaces with single space
        .replace(/^\s+|\s+$/g, '') // Trim whitespace
        .trim();

      return formattedError || 'Runtime Error: Your code encountered an error during execution.';
    }

    formatPythonError(error) {
      if (!error) return '';

      // Clean up Docker and system noise first
      error = error
        .replace(/\/app\/code\.py/g, 'solution.py')
        .replace(/File "\/app\/code\.py"/g, 'File "solution.py"')
        .replace(/python: can't open file.*$/gm, '')
        .replace(/^.*alpine.*$/gm, '')
        .trim();

      // Handle Python tracebacks
      if (error.includes('Traceback')) {
        const lines = error.split('\n');
        let formattedLines = [];
        let inTraceback = false;

        for (let line of lines) {
          line = line.trim();
          if (!line) continue;

          if (line.includes('Traceback')) {
            formattedLines.push('🐍 Python Runtime Error:');
            inTraceback = true;
            continue;
          }

          // Format file references
          if (line.includes('File "solution.py"')) {
            const lineMatch = line.match(/line (\d+)/);
            if (lineMatch) {
              formattedLines.push(`  📍 Line ${lineMatch[1]}:`);
            }
            continue;
          }

          // Format the actual error line
          if (inTraceback && line.includes(':')) {
            const [errorType, ...messageParts] = line.split(':');
            const message = messageParts.join(':').trim();
            formattedLines.push(`  ❌ ${errorType.trim()}: ${message}`);
            break;
          }

          // Add code context if it's not a system path
          if (inTraceback && !line.includes('/') && line.length > 0 && !line.includes('alpine')) {
            formattedLines.push(`     ${line}`);
          }
        }

        return formattedLines.join('\n');
      }

      // Handle syntax errors
      if (error.includes('SyntaxError')) {
        const lineMatch = error.match(/line (\d+)/);
        const lineNum = lineMatch ? lineMatch[1] : 'unknown';
        const message = error.replace(/.*SyntaxError:\s*/, '').replace(/\s*\(.*\)$/, '');
        return `🐍 Python Syntax Error:\n  📍 Line ${lineNum}\n  ❌ ${message}`;
      }

      // Handle indentation errors
      if (error.includes('IndentationError')) {
        const lineMatch = error.match(/line (\d+)/);
        const lineNum = lineMatch ? lineMatch[1] : 'unknown';
        return `🐍 Python Indentation Error:\n  📍 Line ${lineNum}\n  ❌ Check your indentation - use consistent spaces or tabs`;
      }

      // Handle name errors
      if (error.includes('NameError')) {
        const nameMatch = error.match(/name '([^']+)' is not defined/);
        const varName = nameMatch ? nameMatch[1] : 'variable';
        return `🐍 Python Name Error:\n  ❌ Variable '${varName}' is not defined\n  💡 Check spelling or make sure you've declared the variable`;
      }

      // Handle other Python errors
      if (error.includes('Error:')) {
        return `🐍 Python Error:\n  ❌ ${error}`;
      }

      return error || 'Unknown Python error occurred';
    }

    formatJavaError(error) {
      if (!error) return '';

      // Clean up Docker and system noise first
      error = error
        .replace(/\/app\/Main\.java/g, 'Main.java')
        .replace(/javac: file not found:.*$/gm, '')
        .replace(/^.*openjdk.*$/gm, '')
        .replace(/^.*jdk-slim.*$/gm, '')
        .trim();

      // Handle Java compilation errors
      if (error.includes('error:')) {
        const lines = error.split('\n');
        let formattedLines = ['☕ Java Compilation Error:'];

        for (let line of lines) {
          line = line.trim();
          if (!line || line.includes('openjdk') || line.includes('jdk-slim')) continue;

          // Extract line number and error message
          const lineMatch = line.match(/Main\.java:(\d+):\s*error:\s*(.+)/);
          if (lineMatch) {
            formattedLines.push(`  📍 Line ${lineMatch[1]}:`);
            formattedLines.push(`  ❌ ${lineMatch[2]}`);
            continue;
          }

          // Add code context (but skip system noise)
          if (line.includes('^') || (line.length > 0 && !line.includes('Main.java') && !line.includes('error:') && !line.includes('/'))) {
            formattedLines.push(`     ${line}`);
          }
        }

        return formattedLines.join('\n');
      }

      // Handle runtime errors
      if (error.includes('Exception')) {
        const lines = error.split('\n');
        let formattedLines = ['☕ Java Runtime Error:'];

        for (let line of lines) {
          line = line.trim();
          if (!line || line.includes('openjdk') || line.includes('jdk-slim')) continue;

          if (line.includes('Exception:')) {
            const [exceptionType, ...messageParts] = line.split(':');
            const message = messageParts.join(':').trim();
            formattedLines.push(`  ❌ ${exceptionType.trim()}: ${message}`);
          } else if (line.includes('at Main.')) {
            const lineMatch = line.match(/Main\.java:(\d+)/);
            if (lineMatch) {
              formattedLines.push(`  📍 Line ${lineMatch[1]}`);
            }
          }
        }

        return formattedLines.join('\n');
      }

      // Handle common Java errors with helpful hints
      if (error.includes('cannot find symbol')) {
        return `☕ Java Compilation Error:\n  ❌ Cannot find symbol\n  💡 Check variable names, method names, or import statements`;
      }

      if (error.includes('class, interface, or enum expected')) {
        return `☕ Java Compilation Error:\n  ❌ Syntax error in class structure\n  💡 Check your class declaration and closing braces`;
      }

      return `☕ Java Error:\n  ❌ ${error}`;
    }

    formatCppError(error) {
      if (!error) return '';

      // Clean up Docker and system noise first
      error = error
        .replace(/\/app\/program\.cpp/g, 'solution.cpp')
        .replace(/g\+\+: error:.*$/gm, '')
        .replace(/^.*gcc:latest.*$/gm, '')
        .replace(/collect2: error:.*$/gm, '')
        .trim();

      // Handle C++ compilation errors
      if (error.includes('error:')) {
        const lines = error.split('\n');
        let formattedLines = ['🔧 C++ Compilation Error:'];

        for (let line of lines) {
          line = line.trim();
          if (!line || line.includes('gcc:latest') || line.includes('collect2:')) continue;

          // Extract line number and error message
          const lineMatch = line.match(/solution\.cpp:(\d+):(\d+):\s*error:\s*(.+)/);
          if (lineMatch) {
            formattedLines.push(`  📍 Line ${lineMatch[1]}, Column ${lineMatch[2]}:`);
            formattedLines.push(`  ❌ ${lineMatch[3]}`);
            continue;
          }

          // Add code context (but skip system noise)
          if (line.includes('^') || (line.length > 0 && !line.includes('solution.cpp') && !line.includes('error:') && !line.includes('/'))) {
            formattedLines.push(`     ${line}`);
          }
        }

        return formattedLines.join('\n');
      }

      // Handle runtime errors
      if (error.includes('Segmentation fault') || error.includes('Aborted')) {
        return `🔧 C++ Runtime Error:\n  ❌ ${error}\n  💡 Check for array bounds, null pointers, or infinite loops`;
      }

      // Handle linker errors
      if (error.includes('undefined reference')) {
        return `🔧 C++ Linker Error:\n  ❌ Undefined reference\n  💡 Check function declarations and definitions`;
      }

      return `🔧 C++ Error:\n  ❌ ${error}`;
    }

    formatJavaScriptError(error) {
      if (!error) return '';

      // Clean up Docker and system noise first
      error = error
        .replace(/\/app\/code\.js/g, 'solution.js')
        .replace(/^.*node:18-alpine.*$/gm, '')
        .replace(/^.*alpine.*$/gm, '')
        .trim();

      // Handle JavaScript errors
      if (error.includes('Error:') || error.includes('TypeError:') || error.includes('ReferenceError:')) {
        const lines = error.split('\n');
        let formattedLines = ['🟨 JavaScript Error:'];

        for (let line of lines) {
          line = line.trim();
          if (!line || line.includes('node:18-alpine') || line.includes('alpine')) continue;

          // Extract error type and message
          if (line.includes('Error:')) {
            const [errorType, ...messageParts] = line.split(':');
            const message = messageParts.join(':').trim();
            formattedLines.push(`  ❌ ${errorType.trim()}: ${message}`);
          }

          // Extract line number from stack trace
          const lineMatch = line.match(/at.*solution\.js:(\d+):(\d+)/);
          if (lineMatch) {
            formattedLines.push(`  📍 Line ${lineMatch[1]}, Column ${lineMatch[2]}`);
          }
        }

        return formattedLines.join('\n');
      }

      // Handle syntax errors
      if (error.includes('SyntaxError')) {
        const message = error.replace(/.*SyntaxError:\s*/, '').replace(/\s*at.*$/, '');
        return `🟨 JavaScript Syntax Error:\n  ❌ ${message}`;
      }

      // Handle reference errors
      if (error.includes('ReferenceError')) {
        const varMatch = error.match(/(\w+) is not defined/);
        const varName = varMatch ? varMatch[1] : 'variable';
        return `🟨 JavaScript Reference Error:\n  ❌ '${varName}' is not defined\n  💡 Check variable spelling and declaration`;
      }

      return `🟨 JavaScript Error:\n  ❌ ${error}`;
    }


  async runDockerCommand(command, options) {
    return await execLimit(() => execPromise(command, options));
  }

  async initTempDir() {
    try {
      await fs.access(this.tempDir);
    } catch {
      await fs.mkdir(this.tempDir, { recursive: true });
    }
  }

  async executeCode(code, language) {
    console.log(`[${language.toUpperCase()}] Executing code...`);
    
    try {
      if (language === 'python') {
        return await this.runPython(code);
      } else if (language === 'javascript') {
        return await this.runJavaScript(code);
      } else if (language === 'java') {
        return await this.runJava(code);
      } else if (language === 'cpp') {
        return await this.runCpp(code);
      } else {
        return {
          success: false,
          output: '',
          error: `Language "${language}" not supported. Use: python, javascript, java, cpp`,
          executionTime: 0
        };
      }
    } catch (error) {
      console.error('Execution error:', error);
      return {
        success: false,
        output: '',
        error: error.message,
        executionTime: 0
      };
    }
  }

  async runPython(code) {
    const startTime = Date.now();
    const filename = `code_${Date.now()}.py`;
    const filepath = path.join(this.tempDir, filename);
    
    try {
      await fs.writeFile(filepath, code);
      console.log(`Python file created: ${filepath}`);
      
      let dockerPath = filepath;
      if (process.platform === 'win32') {
        dockerPath = filepath.replace(/^([A-Z]):\\/, '/$1/').replace(/\\/g, '/');
      }
      
      const command = `docker run --rm --memory=256m -v "${dockerPath}:/app/code.py" python:3.11-alpine python /app/code.py`;
      console.log(`Running: ${command.substring(0, 100)}...`);
      
      const { stdout, stderr } = await this.runDockerCommand(command, {
        timeout: 10000,
        shell: true,
        windowsHide: true
      });
      
      await fs.unlink(filepath).catch(() => {});
      
      return {
        success: true,
        output: stdout.trim(),
        error: stderr.trim(),
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      await fs.unlink(filepath).catch(() => {});
      return {
        success: false,
        output: '',
        error: this.formatError(error.message, 'python'),
        executionTime: Date.now() - startTime
      };
    }
  }

  async runJavaScript(code) {
      const startTime = Date.now();
      const filename = `code_${Date.now()}.js`;
      const filepath = path.join(this.tempDir, filename);

      try {
        await fs.writeFile(filepath, code);
        console.log(`JavaScript file created: ${filepath}`);

        let dockerPath = filepath;
        if (process.platform === 'win32') {
          dockerPath = filepath.replace(/^([A-Z]):\\/, '/$1/').replace(/\\/g, '/');
        }

        const command = `docker run --rm --memory=256m -v "${dockerPath}:/app/code.js" node:18-alpine node /app/code.js`;
        console.log(`Running: ${command.substring(0, 100)}...`);

        const { stdout, stderr } = await this.runDockerCommand(command, {
          timeout: 10000,
          shell: true,
          windowsHide: true
        });

        await fs.unlink(filepath).catch(() => {});

        return {
          success: true,  
          output: stdout.trim(),
          error: stderr.trim(),
          executionTime: Date.now() - startTime
        };
      } catch (error) {
        await fs.unlink(filepath).catch(() => {});
        return {
          success: false,
          output: '',
          error: this.formatError(error.message, 'javascript'),
          executionTime: Date.now() - startTime
        };
      }
    }


  async runJava(code) {
    const startTime = Date.now();
    const filename = `Main_${Date.now()}.java`;
    const filepath = path.join(this.tempDir, filename);
    
    try {
      await fs.writeFile(filepath, code);
      console.log(`Java file created: ${filepath}`);
      
      let dockerPath = filepath;
      if (process.platform === 'win32') {
        dockerPath = filepath.replace(/^([A-Z]):\\/, '/$1/').replace(/\\/g, '/');
      }
      
      const command = `docker run --rm --memory=256m -v "${dockerPath}:/app/Main.java" openjdk:17-jdk-slim sh -c "cd /app && javac Main.java && java Main"`;
      console.log(`Running: ${command.substring(0, 100)}...`);
      
      const { stdout, stderr } = await this.runDockerCommand(command, {
        timeout: 15000,
        shell: true,
        windowsHide: true
      });
      
      await fs.unlink(filepath).catch(() => {});
      
      return {
        success: true,
        output: stdout.trim(),
        error: stderr.trim(),
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      await fs.unlink(filepath).catch(() => {});
      return {
        success: false,
        output: '',
        error: this.formatError(error.message, 'java'),
        executionTime: Date.now() - startTime
      };
    }
  }

  async runCpp(code) {
    const startTime = Date.now();
    const filename = `program_${Date.now()}.cpp`;
    const filepath = path.join(this.tempDir, filename);
    
    try {
      await fs.writeFile(filepath, code);
      console.log(`C++ file created: ${filepath}`);
      
      let dockerPath = filepath;
      if (process.platform === 'win32') {
        dockerPath = filepath.replace(/^([A-Z]):\\/, '/$1/').replace(/\\/g, '/');
      }
      
      const command = `docker run --rm --memory=256m -v "${dockerPath}:/app/program.cpp" gcc:latest sh -c "cd /app && g++ program.cpp -o program && ./program"`;
      console.log(`Running: ${command.substring(0, 100)}...`);
      
      const { stdout, stderr } = await this.runDockerCommand(command, {
        timeout: 15000,
        shell: true,
        windowsHide: true
      });
      
      await fs.unlink(filepath).catch(() => {});
      
      return {
        success: true,
        output: stdout.trim(),
        error: stderr.trim(),
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      await fs.unlink(filepath).catch(() => {});
      return {
        success: false,
        output: '',
        error: this.formatError(error.message, 'cpp'),
        executionTime: Date.now() - startTime
      };
    }
  }

  // method for test case evaluation
  async evaluateWithTestCases(code, language, testCases) {
    const results = [];
    let totalTestCases = testCases.length;
    let passedTestCases = 0;
    
    console.log(`Evaluating ${language} code against ${totalTestCases} test cases`);
    
    for (let i = 0; i < testCases.length; i++) {
      const testCase = testCases[i];
      const testResult = {
        testCaseId: i + 1,
        input: testCase.input,
        expectedOutput: testCase.expected_output || testCase.output,
        isHidden: testCase.is_hidden || false,
        passed: false
      };
      
      try {
        const executionResult = await this.executeCodeWithInput(code, language, testCase.input);
        
        testResult.actualOutput = executionResult.output;
        testResult.error = executionResult.error;
        testResult.executionTime = executionResult.executionTime;
        
        const normalizedActual = this.normalizeOutput(testResult.actualOutput);
        const normalizedExpected = this.normalizeOutput(testCase.expected_output || testCase.output);
        
        testResult.passed = normalizedActual === normalizedExpected;
        
        if (testResult.passed) {
          passedTestCases++;
        }
        
      } catch (error) {
        testResult.actualOutput = null;
        testResult.error = error.message;
        testResult.passed = false;
      }
      
      results.push(testResult);
    }
    
    const percentage = totalTestCases > 0 ? 
      Math.round((passedTestCases / totalTestCases) * 100) : 0;
    
    return {
      success: true,
      testResults: results,
      summary: {
        totalTestCases,
        passedTestCases,
        failedTestCases: totalTestCases - passedTestCases,
        percentage
      },
      passed: percentage === 100
    };
  }
  
  async executeCodeWithInput(code, language, input) {
    if (language === 'python') {
      return await this.runPythonWithInput(code, input);
    } else if (language === 'javascript') {
      return await this.runJavaScriptWithInput(code, input);
    } else if (language === 'java') {
      return await this.runJavaWithInput(code, input);
    } else if (language === 'cpp') {
      return await this.runCppWithInput(code, input);
    } else {
      throw new Error(`Language "${language}" not supported for input execution`);
    }
  }
  
  normalizeOutput(output) {
    if (!output) return '';
    return output
      .toString()
      .trim()
      .replace(/\r\n/g, '\n')
      .replace(/\s+/g, ' ')
      .trim();
  }
  
  async runPythonWithInput(code, input) {
    const startTime = Date.now();
    const filename = `code_${Date.now()}.py`;
    const filepath = path.join(this.tempDir, filename);
    
    try {
      await fs.writeFile(filepath, code);
      console.log(`Python file created: ${filepath}`);
      
      let dockerPath = filepath;
      if (process.platform === 'win32') {
        dockerPath = filepath.replace(/^([A-Z]):\\/, '/$1/').replace(/\\/g, '/');
      }
      
      // input file create krega, works for both linux and windows
      const inputFilename = `input_${Date.now()}.txt`;
      const inputFilepath = path.join(this.tempDir, inputFilename);
      await fs.writeFile(inputFilepath, input);
      
      let inputDockerPath = inputFilepath;
      if (process.platform === 'win32') {
        inputDockerPath = inputFilepath.replace(/^([A-Z]):\\/, '/$1/').replace(/\\/g, '/');
      }
      
      const command = `docker run --rm --memory=256m -v "${dockerPath}:/app/code.py" -v "${inputDockerPath}:/app/input.txt" python:3.11-alpine sh -c "cat /app/input.txt | python /app/code.py"`;
      
      console.log(`Running command: ${command.substring(0, 150)}...`);
      
      const { stdout, stderr } = await this.runDockerCommand(command, {
        timeout: 10000,
        shell: true,
        windowsHide: true
      });
      
      // Cleanup
      await fs.unlink(filepath).catch(() => {});
      await fs.unlink(inputFilepath).catch(() => {});
      
      return {
        success: true,
        output: stdout.trim(),
        error: stderr.trim(),
        executionTime: Date.now() - startTime
      };
      
    } catch (error) {
      await fs.unlink(filepath).catch(() => {});
      return {
        success: false,
        output: '',
        error: this.formatError(error.message, 'python'),
        executionTime: Date.now() - startTime
      };
    }
  }
  
  async runJavaScriptWithInput(code, input) {
    const startTime = Date.now();
    const filename = `code_${Date.now()}.js`;
    const filepath = path.join(this.tempDir, filename);
    
    try {
      await fs.writeFile(filepath, code);
      console.log(`JavaScript file created: ${filepath}`);
      
      let dockerPath = filepath;
      if (process.platform === 'win32') {
        dockerPath = filepath.replace(/^([A-Z]):\\/, '/$1/').replace(/\\/g, '/');
      }
      
      // input file creation
      const inputFilename = `input_${Date.now()}.txt`;
      const inputFilepath = path.join(this.tempDir, inputFilename);
      await fs.writeFile(inputFilepath, input);
      
      let inputDockerPath = inputFilepath;
      if (process.platform === 'win32') {
        inputDockerPath = inputFilepath.replace(/^([A-Z]):\\/, '/$1/').replace(/\\/g, '/');
      }
      
      const command = `docker run --rm --memory=256m -v "${dockerPath}:/app/code.js" -v "${inputDockerPath}:/app/input.txt" node:18-alpine sh -c "cat /app/input.txt | node /app/code.js"`;
      
      const { stdout, stderr } = await this.runDockerCommand(command, {
        timeout: 10000,
        shell: true,
        windowsHide: true
      });
      
      // Cleanup
      await fs.unlink(filepath).catch(() => {});
      await fs.unlink(inputFilepath).catch(() => {});
      
      return {
        success: true,
        output: stdout.trim(),
        error: stderr.trim(),
        executionTime: Date.now() - startTime
      };
      
    } catch (error) {
      await fs.unlink(filepath).catch(() => {});
      return {
        success: false,
        output: '',
        error: this.formatError(error.message, 'javascript'),
        executionTime: Date.now() - startTime
      };
    }
  }

  async runJavaWithInput(code, input) {
    const startTime = Date.now();
    const filename = `Main_${Date.now()}.java`;
    const filepath = path.join(this.tempDir, filename);
    
    try {
      await fs.writeFile(filepath, code);
      
      let dockerPath = filepath;
      if (process.platform === 'win32') {
        dockerPath = filepath.replace(/^([A-Z]):\\/, '/$1/').replace(/\\/g, '/');
      }
      
      // Create input file
      const inputFilename = `input_${Date.now()}.txt`;
      const inputFilepath = path.join(this.tempDir, inputFilename);
      await fs.writeFile(inputFilepath, input);
      
      let inputDockerPath = inputFilepath;
      if (process.platform === 'win32') {
        inputDockerPath = inputFilepath.replace(/^([A-Z]):\\/, '/$1/').replace(/\\/g, '/');
      }
      
      const command = `docker run --rm --memory=256m -v "${dockerPath}:/app/Main.java" -v "${inputDockerPath}:/app/input.txt" openjdk:17-jdk-slim sh -c "cd /app && javac Main.java && cat /app/input.txt | java Main"`;
      
      const { stdout, stderr } = await this.runDockerCommand(command, {
        timeout: 15000,
        shell: true,
        windowsHide: true
      });
      
      // Cleanup
      await fs.unlink(filepath).catch(() => {});
      await fs.unlink(inputFilepath).catch(() => {});
      
      return {
        success: true,
        output: stdout.trim(),
        error: stderr.trim(),
        executionTime: Date.now() - startTime
      };
      
    } catch (error) {
      await fs.unlink(filepath).catch(() => {});
      return {
        success: false,
        output: '',
        error: this.formatError(error.message, 'java'),
        executionTime: Date.now() - startTime
      };
    }
  }

  async runCppWithInput(code, input) {
    const startTime = Date.now();
    const filename = `program_${Date.now()}.cpp`;
    const filepath = path.join(this.tempDir, filename);
    
    try {
      await fs.writeFile(filepath, code);
      
      let dockerPath = filepath;
      if (process.platform === 'win32') {
        dockerPath = filepath.replace(/^([A-Z]):\\/, '/$1/').replace(/\\/g, '/');
      }
      
      // Create input file
      const inputFilename = `input_${Date.now()}.txt`;
      const inputFilepath = path.join(this.tempDir, inputFilename);
      await fs.writeFile(inputFilepath, input);
      
      let inputDockerPath = inputFilepath;
      if (process.platform === 'win32') {
        inputDockerPath = inputFilepath.replace(/^([A-Z]):\\/, '/$1/').replace(/\\/g, '/');
      }
      
      const command = `docker run --rm --memory=256m -v "${dockerPath}:/app/program.cpp" -v "${inputDockerPath}:/app/input.txt" gcc:latest sh -c "cd /app && g++ program.cpp -o program && cat /app/input.txt | ./program"`;
      
      const { stdout, stderr } = await this.runDockerCommand(command, {
        timeout: 15000,
        shell: true,
        windowsHide: true
      });
      
      // Cleanup
      await fs.unlink(filepath).catch(() => {});
      await fs.unlink(inputFilepath).catch(() => {});
      
      return {
        success: true,
        output: stdout.trim(),
        error: stderr.trim(),
        executionTime: Date.now() - startTime
      };
      
    } catch (error) {
      await fs.unlink(filepath).catch(() => {});
      return {
        success: false,
        output: '',
        error: this.formatError(error.message, 'cpp'),
        executionTime: Date.now() - startTime
      };
    }
  }
}

const codeExecutionService = new CodeExecutionService();
module.exports = codeExecutionService;