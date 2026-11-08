export async function claimNickname(
  previous: string,
  nickname: string,
  send: (line: string) => void,
  waitFor: (
    description: string,
    predicate: (line: string) => boolean,
  ) => Promise<string>,
): Promise<void> {
  const isConfirmation = (line: string) =>
    line.includes(`:${previous}!`) &&
    (line.includes(` NICK :${nickname}`) || line.includes(` NICK ${nickname}`));
  send(`NICK ${nickname}`);
  const response = await waitFor(
    `NICK confirmation or conflict for ${nickname}`,
    (line) => isConfirmation(line) || isNickConflict(line, nickname),
  );
  if (isConfirmation(response)) return;

  await waitFor(`${nickname} holder to depart`, (line) =>
    isNickDeparture(line, nickname),
  );
  send(`NICK ${nickname}`);
  await waitFor(`NICK confirmation for ${nickname}`, isConfirmation);
}

function isNickConflict(line: string, nickname: string): boolean {
  const rejected = / 433 \S+ (\S+) /u.exec(line)?.[1];
  return rejected?.toLowerCase() === nickname.toLowerCase();
}

function isNickDeparture(line: string, nickname: string): boolean {
  const source = /^(?:@\S+ )?:([^! ]+)!/u.exec(line)?.[1];
  return (
    source?.toLowerCase() === nickname.toLowerCase() &&
    (line.includes(" QUIT ") || line.includes(" NICK "))
  );
}
