-- A resume after a restart says nothing on the tile any more; clear the note earlier versions left on agents resumed before.
UPDATE agents SET notice = NULL WHERE notice = 'Relaunched after a restart';
