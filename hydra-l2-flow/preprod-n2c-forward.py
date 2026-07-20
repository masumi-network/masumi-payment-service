import os
import socket
import sys
import threading

UNIX_PATH = sys.argv[1]
TCP_PORT = int(sys.argv[2])


def pump(src: socket.socket, dst: socket.socket) -> None:
  try:
    while True:
      data = src.recv(65536)
      if not data:
        break
      dst.sendall(data)
  except OSError:
    pass
  finally:
    for sock in (src, dst):
      try:
        sock.shutdown(socket.SHUT_RDWR)
      except OSError:
        pass


def handle(conn: socket.socket) -> None:
  try:
    tcp = socket.create_connection(('127.0.0.1', TCP_PORT))
  except OSError as error:
    print(f'[forward] TCP connect failed: {error}', file=sys.stderr)
    conn.close()
    return

  threading.Thread(target=pump, args=(conn, tcp), daemon=True).start()
  threading.Thread(target=pump, args=(tcp, conn), daemon=True).start()


def main() -> None:
  if os.path.exists(UNIX_PATH):
    os.unlink(UNIX_PATH)

  server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
  server.bind(UNIX_PATH)
  server.listen(16)
  print(f'[forward] listening {UNIX_PATH} -> 127.0.0.1:{TCP_PORT}', file=sys.stderr)

  while True:
    conn, _ = server.accept()
    handle(conn)


main()
