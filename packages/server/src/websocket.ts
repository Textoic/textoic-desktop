import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageReader,
  type MessageWriter,
} from "vscode-jsonrpc/node";
import { createConnection, type Connection } from "vscode-languageserver/node";
import type { WebSocket } from "ws";

class WebSocketMessageReader extends AbstractMessageReader implements MessageReader {
  private readonly socket: WebSocket;

  constructor(socket: WebSocket) {
    super();
    this.socket = socket;
  }

  listen(callback: DataCallback): Disposable {
    const onMessage = (data: unknown) => {
      try {
        callback(JSON.parse(String(data)) as Message);
      } catch (cause) {
        this.fireError(cause);
      }
    };
    const onClose = () => this.fireClose();
    const onError = (error: Error) => this.fireError(error);
    this.socket.on("message", onMessage);
    this.socket.on("close", onClose);
    this.socket.on("error", onError);
    return {
      dispose: () => {
        this.socket.off("message", onMessage);
        this.socket.off("close", onClose);
        this.socket.off("error", onError);
      },
    };
  }
}

class WebSocketMessageWriter extends AbstractMessageWriter implements MessageWriter {
  private readonly socket: WebSocket;
  private errors = 0;

  constructor(socket: WebSocket) {
    super();
    this.socket = socket;
  }

  async write(message: Message): Promise<void> {
    if (this.socket.readyState !== this.socket.OPEN) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.socket.send(JSON.stringify(message), (error) => {
        if (error) {
          this.errors += 1;
          this.fireError(error, message, this.errors);
        }

        resolve();
      });
    });
  }

  end(): void {
    return undefined;
  }
}

export const connectionOverWebSocket = (socket: WebSocket): Connection =>
  createConnection(new WebSocketMessageReader(socket), new WebSocketMessageWriter(socket));
