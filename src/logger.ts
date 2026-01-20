export enum LogLevel {
	ERROR = 0,
	WARN = 1,
	INFO = 2,
	DEBUG = 3
}

export class Logger {
	private logLevel: LogLevel;
	private prefix: string = "Readwise:";

	constructor(logLevel: LogLevel = LogLevel.WARN) {
		this.logLevel = logLevel;
	}

	setLogLevel(level: LogLevel): void {
		this.logLevel = level;
	}

	getLogLevel(): LogLevel {
		return this.logLevel;
	}

	error(message: string, ...args: any[]): void {
		if (this.logLevel >= LogLevel.ERROR) {
			console.error(`${this.prefix} [ERROR]`, message, ...args);
		}
	}

	warn(message: string, ...args: any[]): void {
		if (this.logLevel >= LogLevel.WARN) {
			console.warn(`${this.prefix} [WARN]`, message, ...args);
		}
	}

	info(message: string, ...args: any[]): void {
		if (this.logLevel >= LogLevel.INFO) {
			console.log(`${this.prefix} [INFO]`, message, ...args);
		}
	}

	debug(message: string, ...args: any[]): void {
		if (this.logLevel >= LogLevel.DEBUG) {
			console.log(`${this.prefix} [DEBUG]`, message, ...args);
		}
	}
}
