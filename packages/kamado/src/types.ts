export interface Page {
	id: number;
	no: number;
	deleted: string;
	originalUrl: string;
	moveToUrl: string;
	isConvertTarget: number;
	isConverted: number;
	title: string;
	subTitle: string;
	description: string;
	ogpImg: string;
	enableLocalNav: number;
	localNavPosition: string;
	localNavDepth: number;
	layout: string;
	enableHero: boolean;
	enableDescriptionBlock: boolean;
	enableListOfLinkInPage: boolean;
	to: string;
	from: string;
	scripts: string[];
}
